#!/usr/bin/env node
// Fetches a compact fitness snapshot from Hevy + Oura and writes fitness.json.enc.
// Runs in GitHub Actions (which has open internet); the cloud routines, which
// cannot reach Hevy/Oura directly, read the committed file.
//
// The payload includes the full weekly-coach analysis under `coach`:
//  - per-lift e1RM, PRs, regression-based trend, stall detection
//  - set-level detail (last 3 sessions per active lift, incl. RPE when logged)
//  - 28-day muscle balance
// plus `history`: one compact entry per ISO week (kept in history.json.enc,
// also committed) so the coach can diff this week against previous weeks.
//
// Tokens come from env (GitHub Actions secrets): HEVY_API_KEY, OURA_TOKEN,
// FITNESS_KEY (encryption passphrase). Node 18+ (built-in fetch).

const fs = require("fs");
const crypto = require("crypto");

const HEVY_KEY = process.env.HEVY_API_KEY;
const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA = "https://api.ouraring.com/v2/usercollection";
const HEVY = "https://api.hevyapp.com/v1";
const ACTIVE_DAYS = 35;
const HISTORY_WEEKS = 16;

// ---- crypto helpers (key = sha256(passphrase); base64(iv || AES-256-CBC)) --
function keyFromPassphrase(pass) {
  return crypto.createHash("sha256").update(pass).digest();
}
function encryptToFile(path, obj, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  fs.writeFileSync(path, Buffer.concat([iv, enc]).toString("base64") + "\n");
}
function decryptFile(path, key) {
  const buf = Buffer.from(fs.readFileSync(path, "utf8").trim(), "base64");
  const dec = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return JSON.parse(Buffer.concat([dec.update(buf.subarray(16)), dec.final()]).toString("utf8"));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}
// ISO-8601 week id, e.g. "2026-W30".
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Oura treats end_date as EXCLUSIVE, so push it to tomorrow to include today.
function ouraRange(startDaysAgo) {
  return `start_date=${isoDate(daysAgo(startDaysAgo))}&end_date=${isoDate(daysAgo(-1))}`;
}

async function hevyStrength() {
  const data = await getJSON(`${HEVY}/workouts?page=1&pageSize=8`, { "api-key": HEVY_KEY });
  return (data.workouts || []).map((w) => ({
    date: (w.start_time || "").slice(0, 10),
    title: w.title,
  }));
}

// ---- Weekly-coach analysis ------------------------------------------------
async function hevyAllPages(ep, field, ps) {
  let p = 1,
    pc = 1,
    all = [];
  do {
    const d = await getJSON(`${HEVY}/${ep}?page=${p}&pageSize=${ps}`, { "api-key": HEVY_KEY });
    pc = d.page_count || 1;
    all.push(...(d[field] || []));
    p++;
  } while (p <= pc);
  return all;
}

const round = (n, d = 1) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const daySlice = (i) => i.slice(0, 10);
const daysSince = (i) => Math.floor((Date.now() - new Date(i)) / 86400000);
const e1rm = (w, r) => (!w || !r ? 0 : w * (1 + r / 30));
const setVol = (sets) => sets.reduce((v, s) => v + (s.weight_kg || 0) * (s.reps || 0), 0);

// Least-squares slope over the last up-to-6 e1RM points, expressed as total
// % change across that window. Far less noisy than first-vs-last: one bad
// day at either end no longer flips a lift between climbing and stalled.
// Only sessions from the last 60 days count, so the trend describes the
// current training block: a lift restarted lighter after a long break reads
// as flat-at-the-new-weight, not as a months-long collapse.
function regressionTrendPct(entries) {
  const pts = entries
    .filter((x) => daysSince(x.date + "T12:00:00Z") <= 60)
    .map((x) => x.bestE1rm)
    .slice(-6);
  const n = pts.length;
  if (n < 2) return 0;
  if (n === 2) {
    return pts[0] ? round(((pts[1] - pts[0]) / pts[0]) * 100, 1) : 0;
  }
  const xs = pts.map((_, i) => i);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = pts.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (pts[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = den ? num / den : 0;
  const fittedFirst = my - slope * mx;
  if (!fittedFirst) return 0;
  return round(((slope * (n - 1)) / fittedFirst) * 100, 1);
}

// Compact one-set string: "80x5" or "80x5@8" when RPE was logged.
function setStr(s) {
  return `${s.weight_kg}x${s.reps}${s.rpe != null ? `@${s.rpe}` : ""}`;
}

async function hevyCoachAnalysis() {
  const templates = await hevyAllPages("exercise_templates", "exercise_templates", 100);
  let workouts = await hevyAllPages("workouts", "workouts", 10);
  workouts.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const tpl = new Map(templates.map((t) => [t.id, t]));
  const muscleOf = (ex) => (tpl.get(ex.exercise_template_id) || {}).primary_muscle_group || "other";

  const last7 = workouts.filter((w) => daysSince(w.start_time) <= 7).length;
  const last28 = workouts.filter((w) => daysSince(w.start_time) <= 28).length;

  const hist = {};
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      const wt = (ex.sets || []).filter((s) => s.weight_kg != null && s.reps != null);
      if (!wt.length) continue;
      const top = Math.max.apply(null, wt.map((s) => s.weight_kg));
      const best = wt.reduce(
        (m, s) => (e1rm(s.weight_kg, s.reps) >= m.v ? { v: e1rm(s.weight_kg, s.reps), s } : m),
        { v: -1, s: wt[0] }
      );
      (hist[ex.title] = hist[ex.title] || []).push({
        date: daySlice(w.start_time),
        topWeight: top,
        bestE1rm: round(best.v),
        bestSet: best.s.weight_kg + "kg x " + best.s.reps,
        muscle: muscleOf(ex),
        sets: wt.map(setStr),
      });
    }
  }
  for (const k in hist) hist[k].sort((a, b) => a.date.localeCompare(b.date));

  const lifts = [];
  for (const t in hist) {
    const s = hist[t];
    if (s.length < 2) continue;
    const prE = Math.max.apply(null, s.map((x) => x.bestE1rm));
    const prW = Math.max.apply(null, s.map((x) => x.topWeight));
    const tr = regressionTrendPct(s);
    const last = s[s.length - 1];
    const ds = daysSince(last.date + "T12:00:00Z");
    const atPr = last.bestE1rm >= prE - 0.01;
    const active = ds <= ACTIVE_DAYS;
    lifts.push({
      title: t,
      muscle: last.muscle,
      timesLogged: s.length,
      prWeight: prW,
      prE1rm: prE,
      currentBestSet: last.bestSet,
      currentE1rm: last.bestE1rm,
      trendPct: tr,
      daysSinceLastDone: ds,
      active,
      atOrNearPr: atPr,
      stalled: active && s.length >= 4 && tr <= 0.5 && !atPr,
      // Set-level detail so the coach sees actual work (scheme, rep
      // progression, RPE), not just the single best set. Active lifts only,
      // to keep the payload compact.
      recentSessions: active
        ? s.slice(-3).map((x) => ({ date: x.date, sets: x.sets }))
        : undefined,
    });
  }
  lifts.sort((a, b) => b.timesLogged - a.timesLogged);

  const vol = {},
    sc = {};
  for (const w of workouts) {
    if (daysSince(w.start_time) > 28) continue;
    for (const ex of w.exercises || []) {
      const m = muscleOf(ex);
      const wt = (ex.sets || []).filter((s) => s.weight_kg != null && s.reps != null);
      vol[m] = (vol[m] || 0) + setVol(wt);
      sc[m] = (sc[m] || 0) + (ex.sets || []).length;
    }
  }
  const totv = Object.values(vol).reduce((a, b) => a + b, 0) || 1;
  const mb = Object.keys(vol)
    .map((m) => ({ muscle: m, volumeKg: round(vol[m], 0), sets: sc[m] || 0, pct: round((vol[m] / totv) * 100, 1) }))
    .sort((a, b) => b.volumeKg - a.volumeKg);

  // Weekly raw entries for the history: rebuilt from the FULL workout log, so
  // week-over-week comparisons are backfilled from day one. Per ISO week:
  // lifting session count, rolling 4-week frequency, and each lift trained
  // that week with its best e1RM/set of the week.
  const weekOf = (dateStr) => isoWeek(new Date(dateStr + "T12:00:00Z"));
  const sessionsByWeek = {};
  for (const w of workouts) {
    const wk = weekOf(daySlice(w.start_time));
    sessionsByWeek[wk] = (sessionsByWeek[wk] || 0) + 1;
  }
  const liftsByWeek = {};
  for (const t in hist) {
    for (const x of hist[t]) {
      const wk = weekOf(x.date);
      const slot = ((liftsByWeek[wk] = liftsByWeek[wk] || {})[t] =
        liftsByWeek[wk][t] || { e1rm: -1, bestSet: "" });
      if (x.bestE1rm > slot.e1rm) {
        slot.e1rm = x.bestE1rm;
        slot.bestSet = x.bestSet;
      }
    }
  }
  const weeklyRaw = [];
  for (let k = HISTORY_WEEKS - 1; k >= 0; k--) {
    const ref = new Date(Date.now() - k * 7 * 86400000);
    const dow = ref.getUTCDay() || 7;
    const monday = new Date(ref.getTime() - (dow - 1) * 86400000);
    const weekEnd = monday.getTime() + 7 * 86400000; // exclusive
    const cnt28 = workouts.filter((w) => {
      const t = new Date(w.start_time).getTime();
      return t < weekEnd && t >= weekEnd - 28 * 86400000;
    }).length;
    const wk = isoWeek(ref);
    weeklyRaw.push({
      week: wk,
      date: isoDate(monday),
      sessions: sessionsByWeek[wk] || 0,
      perWeek: round(cnt28 / 4, 1),
      lifts: liftsByWeek[wk] || {},
    });
  }

  return {
    weeklyRaw,
    total: workouts.length,
    lastDate: workouts.length ? daySlice(workouts[0].start_time) : null,
    daysSinceLast: workouts.length ? daysSince(workouts[0].start_time) : null,
    sessionsLast7: last7,
    sessionsLast28: last28,
    perWeek: round(last28 / 4, 1),
    lifts,
    muscleBalance28d: mb,
  };
}

// History: one entry per ISO week for the last HISTORY_WEEKS weeks. Lift and
// session data are REBUILT from the full Hevy history on every run (so the
// first run already backfills months of week-over-week data). Run volume can
// only be observed through the relay's 28-day Oura window, so values recorded
// close to the fact are preserved from the previous history file; the current
// week is always recomputed.
function buildHistory(prevHistory, weeklyRaw, runs, runsOk) {
  const prev = new Map(prevHistory.map((h) => [h.week, h]));
  const runsByWeek = {},
    runMinByWeek = {};
  if (runsOk) {
    for (const r of runs) {
      const wk = isoWeek(new Date(r.day + "T12:00:00Z"));
      runsByWeek[wk] = (runsByWeek[wk] || 0) + 1;
      runMinByWeek[wk] = (runMinByWeek[wk] || 0) + (r.duration_min || 0);
    }
  }
  const nowWeek = isoWeek(new Date());
  // A past week's runs are only fully visible if its Monday is inside the
  // 28-day Oura window.
  const fullyCovered = (mondayIso) =>
    new Date(mondayIso + "T00:00:00Z").getTime() >= Date.now() - 27 * 86400000;
  return weeklyRaw.map((e) => {
    const p = prev.get(e.week);
    let runs7 = null,
      runMin7 = null;
    if (e.week === nowWeek && runsOk) {
      runs7 = runsByWeek[e.week] || 0;
      runMin7 = runMinByWeek[e.week] || 0;
    } else if (p && p.runs7 != null) {
      runs7 = p.runs7;
      runMin7 = p.runMin7;
    } else if (runsOk && fullyCovered(e.date)) {
      runs7 = runsByWeek[e.week] || 0;
      runMin7 = runMinByWeek[e.week] || 0;
    }
    return { ...e, runs7, runMin7 };
  });
}
// ---------------------------------------------------------------------------

async function ouraRuns() {
  // 28 days so the coach can see run-volume trend, not just the last few days.
  const data = await getJSON(`${OURA}/workout?${ouraRange(28)}`, { Authorization: `Bearer ${OURA_TOKEN}` });
  return (data.data || [])
    .filter((w) => (w.activity || "").toLowerCase() === "running")
    .map((w) => {
      const durMin =
        w.start_datetime && w.end_datetime
          ? Math.round((new Date(w.end_datetime) - new Date(w.start_datetime)) / 60000)
          : null;
      // Oura distance is in meters. HR-auto-detected runs (no GPS) report a
      // meaningless sub-100m value, so treat anything under 100m as no-distance
      // and let duration + intensity carry the signal.
      const distKm =
        w.distance != null && w.distance >= 100 ? +(w.distance / 1000).toFixed(2) : null;
      return {
        day: w.day,
        intensity: w.intensity || null,
        distance_km: distKm,
        duration_min: durMin,
      };
    });
}

// Last 7 days of readiness + sleep with averages and direction, so the coach
// judges the WEEK's recovery, not whichever single day the snapshot ran on.
// trend = second-half average minus first-half average (negative = sagging).
async function ouraRecovery7() {
  const auth = { Authorization: `Bearer ${OURA_TOKEN}` };
  const [rd, sd] = await Promise.all([
    getJSON(`${OURA}/daily_readiness?${ouraRange(7)}`, auth),
    getJSON(`${OURA}/daily_sleep?${ouraRange(7)}`, auth),
  ]);
  const byDay = {};
  for (const r of rd.data || []) byDay[r.day] = { day: r.day, readiness: r.score, sleep: null };
  for (const s of sd.data || []) {
    (byDay[s.day] = byDay[s.day] || { day: s.day, readiness: null, sleep: null }).sleep = s.score;
  }
  const days = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  const series = (k) => days.map((d) => d[k]).filter((v) => v != null);
  const avg = (a) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 0) : null);
  const trend = (a) =>
    a.length >= 4
      ? round(avg(a.slice(Math.ceil(a.length / 2))) - avg(a.slice(0, Math.floor(a.length / 2))), 0)
      : 0;
  const r = series("readiness"),
    s = series("sleep");
  return {
    days,
    readinessAvg: avg(r),
    readinessMin: r.length ? Math.min.apply(null, r) : null,
    readinessTrend: trend(r),
    sleepAvg: avg(s),
    sleepTrend: trend(s),
  };
}

async function ouraLatest(endpoint, startDaysAgo, pick) {
  const data = await getJSON(`${OURA}/${endpoint}?${ouraRange(startDaysAgo)}`, {
    Authorization: `Bearer ${OURA_TOKEN}`,
  });
  const rows = data.data || [];
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];
  return pick(latest);
}

async function main() {
  const passphrase = process.env.FITNESS_KEY;
  if (!passphrase) {
    console.error("FITNESS_KEY is not set. Refusing to write plaintext.");
    process.exit(1);
  }
  const key = keyFromPassphrase(passphrase);

  const errors = [];
  const out = {
    generated_at: new Date().toISOString(),
    strength: [],
    runs: [],
    readiness: null,
    sleep: null,
    recovery7: null,
    coach: null,
    history: [],
    errors,
  };

  const tasks = [
    hevyStrength().then((r) => (out.strength = r)).catch((e) => errors.push(`hevy: ${e.message}`)),
    hevyCoachAnalysis().then((r) => (out.coach = r)).catch((e) => errors.push(`hevy_coach: ${e.message}`)),
    ouraRuns().then((r) => (out.runs = r)).catch((e) => errors.push(`oura_runs: ${e.message}`)),
    ouraRecovery7().then((r) => (out.recovery7 = r)).catch((e) => errors.push(`oura_recovery: ${e.message}`)),
    ouraLatest("daily_readiness", 4, (r) => ({
      day: r.day,
      score: r.score,
      hrv_balance: r.contributors?.hrv_balance ?? null,
      resting_heart_rate: r.contributors?.resting_heart_rate ?? null,
      recovery_index: r.contributors?.recovery_index ?? null,
    }))
      .then((r) => (out.readiness = r))
      .catch((e) => errors.push(`oura_readiness: ${e.message}`)),
    ouraLatest("daily_sleep", 2, (r) => ({ day: r.day, score: r.score }))
      .then((r) => (out.sleep = r))
      .catch((e) => errors.push(`oura_sleep: ${e.message}`)),
  ];

  await Promise.all(tasks);

  // Weekly history: decrypt the committed file, fold in this week, keep 16.
  let history = [];
  if (fs.existsSync("history.json.enc")) {
    try {
      history = decryptFile("history.json.enc", key);
    } catch (e) {
      errors.push(`history_read: ${e.message}`);
    }
  }
  if (out.coach) {
    const runsOk = !errors.some((e) => e.startsWith("oura_runs"));
    history = buildHistory(history, out.coach.weeklyRaw, out.runs, runsOk);
    delete out.coach.weeklyRaw; // lives in out.history, no need to ship twice
    encryptToFile("history.json.enc", history, key);
  }
  out.history = history;

  // Encrypt before committing: the repo is public, so only ciphertext is ever
  // written to disk or logs.
  encryptToFile("fitness.json.enc", out, key);

  // Log counts only - never the values, since Actions logs are public.
  const activeLifts = out.coach ? out.coach.lifts.filter((l) => l.active).length : 0;
  console.log(
    `Wrote fitness.json.enc: strength=${out.strength.length} runs=${out.runs.length} ` +
      `readiness=${out.readiness ? "ok" : "missing"} sleep=${out.sleep ? "ok" : "missing"} ` +
      `recovery7=${out.recovery7 ? "ok" : "missing"} ` +
      `coach=${out.coach ? `ok(${activeLifts} active lifts)` : "missing"} ` +
      `history=${out.history.length}wk errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
