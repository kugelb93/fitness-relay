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

  return {
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

// One compact entry per ISO week: the week's per-lift state for active lifts
// plus run volume. Re-running within the same week overwrites that week's
// entry, so each entry ends up holding the week's final state.
function updateHistory(history, coach, runs, runsOk) {
  const now = new Date();
  const last7Runs = runsOk
    ? runs.filter((r) => daysSince(r.day + "T12:00:00Z") <= 7)
    : null;
  const entry = {
    week: isoWeek(now),
    date: isoDate(now),
    sessionsLast7: coach.sessionsLast7,
    perWeek: coach.perWeek,
    runs7: last7Runs ? last7Runs.length : null,
    runMin7: last7Runs ? last7Runs.reduce((a, r) => a + (r.duration_min || 0), 0) : null,
    lifts: {},
  };
  for (const l of coach.lifts) {
    if (!l.active) continue;
    entry.lifts[l.title] = { e1rm: l.currentE1rm, bestSet: l.currentBestSet };
  }
  const rest = history.filter((h) => h.week !== entry.week);
  rest.push(entry);
  rest.sort((a, b) => a.week.localeCompare(b.week));
  return rest.slice(-HISTORY_WEEKS);
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
    coach: null,
    history: [],
    errors,
  };

  const tasks = [
    hevyStrength().then((r) => (out.strength = r)).catch((e) => errors.push(`hevy: ${e.message}`)),
    hevyCoachAnalysis().then((r) => (out.coach = r)).catch((e) => errors.push(`hevy_coach: ${e.message}`)),
    ouraRuns().then((r) => (out.runs = r)).catch((e) => errors.push(`oura_runs: ${e.message}`)),
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
    history = updateHistory(history, out.coach, out.runs, runsOk);
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
      `coach=${out.coach ? `ok(${activeLifts} active lifts)` : "missing"} ` +
      `history=${out.history.length}wk errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
