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
// also committed) so the coach can diff this week against previous weeks,
// and `nutrition`: intake, macros and bodyweight from Apple Health via the
// breathing-bot Worker (optional, see NUTRITION_URL below).
//
// Tokens come from env (GitHub Actions secrets): HEVY_API_KEY, OURA_TOKEN,
// FITNESS_KEY (encryption passphrase), INGEST_TOKEN (optional, nutrition).
// Node 18+ (built-in fetch).

const fs = require("fs");
const crypto = require("crypto");

const HEVY_KEY = process.env.HEVY_API_KEY;
const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA = "https://api.ouraring.com/v2/usercollection";
const HEVY = "https://api.hevyapp.com/v1";
const ACTIVE_DAYS = 35;
const HISTORY_WEEKS = 16;

// Nutrition + bodyweight originate in MacroFactor, which has no public API. It
// writes them into Apple Health, Apple Health is device-local with no server
// endpoint, so his iPhone (Health Auto Export) POSTs them to the breathing-bot
// Worker and we read them back from there. OPTIONAL by design: with no
// INGEST_TOKEN set the snapshot simply carries no nutrition and the coach omits
// the section, rather than the whole readout failing.
const NUTRITION_URL = process.env.NUTRITION_URL ||
  "https://breathing-bot.w-kugelberg.workers.dev/export/nutrition";
const INGEST_TOKEN = process.env.INGEST_TOKEN;

// Body composition takes a different road on purpose. Withings has a real public
// API, so the Worker talks to it directly instead of waiting on an Apple Health
// push, and Apple Health will not carry muscle mass at all. Muscle mass is the
// number that makes a weight change interpretable, so the detour is the point.
// Independently optional: absent body comp must not disturb nutrition.
const BODY_URL = process.env.BODY_URL ||
  "https://breathing-bot.w-kugelberg.workers.dev/export/body?days=28";

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

// Oura's daily endpoints paginate with next_token and return HTTP 200 with a
// partial body when a range exceeds one page, so any long request truncates
// silently without this. The page cap is a runaway guard, not an expected limit.
async function getJSONAll(url, headers) {
  let next = null, out = [], pages = 0;
  do {
    const page = await getJSON(next ? `${url}&next_token=${encodeURIComponent(next)}` : url, headers);
    out = out.concat(page.data || []);
    next = page.next_token || null;
    pages++;
  } while (next && pages < 20);
  return out;
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
function buildHistory(prevHistory, weeklyRaw, runs, runsOk, recovery7) {
  const prev = new Map(prevHistory.map((h) => [h.week, h]));
  const runsByWeek = {},
    runMinByWeek = {},
    runHrByWeek = {};
  if (runsOk) {
    for (const r of runs) {
      const wk = isoWeek(new Date(r.day + "T12:00:00Z"));
      runsByWeek[wk] = (runsByWeek[wk] || 0) + 1;
      runMinByWeek[wk] = (runMinByWeek[wk] || 0) + (r.duration_min || 0);
      if (r.avg_hr != null) (runHrByWeek[wk] = runHrByWeek[wk] || []).push(r.avg_hr);
    }
  }
  const weekHr = (wk) =>
    runHrByWeek[wk] && runHrByWeek[wk].length
      ? Math.round(runHrByWeek[wk].reduce((a, b) => a + b, 0) / runHrByWeek[wk].length)
      : null;
  const nowWeek = isoWeek(new Date());
  // A past week's runs are only fully visible if its Monday is inside the
  // 28-day Oura window.
  const fullyCovered = (mondayIso) =>
    new Date(mondayIso + "T00:00:00Z").getTime() >= Date.now() - 27 * 86400000;
  return weeklyRaw.map((e) => {
    const p = prev.get(e.week);
    let runs7 = null,
      runMin7 = null,
      runHr7 = null;
    if (e.week === nowWeek && runsOk) {
      runs7 = runsByWeek[e.week] || 0;
      runMin7 = runMinByWeek[e.week] || 0;
      runHr7 = weekHr(e.week);
    } else if (p && p.runs7 != null) {
      runs7 = p.runs7;
      runMin7 = p.runMin7;
      runHr7 = p.runHr7 != null ? p.runHr7 : runsOk && fullyCovered(e.date) ? weekHr(e.week) : null;
    } else if (runsOk && fullyCovered(e.date)) {
      runs7 = runsByWeek[e.week] || 0;
      runMin7 = runMinByWeek[e.week] || 0;
      runHr7 = weekHr(e.week);
    }
    // Weekly recovery averages, now backfilled for EVERY week straight from
    // Oura rather than only the current one. The note that used to sit here
    // claimed backfill was impossible; Oura's daily endpoints take any
    // start_date, so it never was. A previously stored value still wins when
    // Oura's window no longer reaches that week, so history is never lost.
    const wkRec = recovery7 && recovery7.weekly ? recovery7.weekly[e.week] : null;
    const recAvg7 = wkRec && wkRec.recAvg7 != null
      ? wkRec.recAvg7
      : p && p.recAvg7 != null ? p.recAvg7 : null;
    const sleepAvg7 = wkRec && wkRec.sleepAvg7 != null
      ? wkRec.sleepAvg7
      : p && p.sleepAvg7 != null ? p.sleepAvg7 : null;
    return { ...e, runs7, runMin7, runHr7, recAvg7, sleepAvg7 };
  });
}
// ---------------------------------------------------------------------------

// Per-run heart rate from the Oura time-series endpoint: avg, max, and
// cardiac drift (second-half avg vs first-half avg, %). Drift is a real
// intensity/strain marker, far more useful than Oura's coarse intensity label.
async function runHeartRate(startIso, endIso) {
  try {
    const q = `start_datetime=${encodeURIComponent(startIso)}&end_datetime=${encodeURIComponent(endIso)}`;
    const data = await getJSON(`${OURA}/heartrate?${q}`, { Authorization: `Bearer ${OURA_TOKEN}` });
    const bpm = (data.data || []).map((s) => s.bpm).filter((b) => b > 0);
    if (bpm.length < 4) return { avg_hr: null, max_hr: null, hr_drift_pct: null };
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const half = Math.floor(bpm.length / 2);
    const drift = round(((avg(bpm.slice(half)) - avg(bpm.slice(0, half))) / avg(bpm.slice(0, half))) * 100, 1);
    return { avg_hr: Math.round(avg(bpm)), max_hr: Math.max.apply(null, bpm), hr_drift_pct: drift };
  } catch (e) {
    return { avg_hr: null, max_hr: null, hr_drift_pct: null };
  }
}

async function ouraRuns() {
  // 28 days so the coach can see run-volume trend, not just the last few days.
  const data = await getJSON(`${OURA}/workout?${ouraRange(28)}`, { Authorization: `Bearer ${OURA_TOKEN}` });
  const runs = (data.data || []).filter((w) => (w.activity || "").toLowerCase() === "running");
  return Promise.all(
    runs.map(async (w) => {
      const durMin =
        w.start_datetime && w.end_datetime
          ? Math.round((new Date(w.end_datetime) - new Date(w.start_datetime)) / 60000)
          : null;
      // Oura distance is in meters. HR-auto-detected runs (no GPS) report a
      // meaningless sub-100m value, so treat anything under 100m as no-distance
      // and let duration + intensity carry the signal.
      const distKm =
        w.distance != null && w.distance >= 100 ? +(w.distance / 1000).toFixed(2) : null;
      const hr =
        w.start_datetime && w.end_datetime
          ? await runHeartRate(w.start_datetime, w.end_datetime)
          : { avg_hr: null, max_hr: null, hr_drift_pct: null };
      return {
        day: w.day,
        intensity: w.intensity || null,
        distance_km: distKm,
        duration_min: durMin,
        ...hr,
      };
    })
  );
}

// Last 7 days of readiness + sleep with averages and direction, so the coach
// judges the WEEK's recovery, not whichever single day the snapshot ran on.
// trend = second-half average minus first-half average (negative = sagging).
// Oura keeps years of daily readiness and sleep, and its API accepts any
// start_date, so the old 7-day window was a self-imposed limit rather than a
// data one. buildHistory used to assert that no backfill was possible; that was
// simply wrong, and it cost 15 of 16 history weeks their recovery numbers and
// left every trend word with nothing to be relative to. One long paged request
// fills all of them. The trailing-7 figures keep their old names and shapes, so
// the coach prompt and the committed history file are unaffected.
const RECOVERY_HISTORY_DAYS = 400; // ~13 months: reaches the same month last year.

async function ouraRecovery7() {
  const auth = { Authorization: `Bearer ${OURA_TOKEN}` };
  const [rd, sd] = await Promise.all([
    getJSONAll(`${OURA}/daily_readiness?${ouraRange(RECOVERY_HISTORY_DAYS)}`, auth),
    getJSONAll(`${OURA}/daily_sleep?${ouraRange(RECOVERY_HISTORY_DAYS)}`, auth),
  ]);
  const byDay = {};
  for (const r of rd) byDay[r.day] = { day: r.day, readiness: r.score, sleep: null };
  for (const s of sd) {
    (byDay[s.day] = byDay[s.day] || { day: s.day, readiness: null, sleep: null }).sleep = s.score;
  }
  const all = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));

  const avg = (a) => (a.length ? round(a.reduce((x, y) => x + y, 0) / a.length, 0) : null);
  const series = (rows, k) => rows.map((d) => d[k]).filter((v) => v != null);
  const trend = (a) =>
    a.length >= 4
      ? round(avg(a.slice(Math.ceil(a.length / 2))) - avg(a.slice(0, Math.floor(a.length / 2))), 0)
      : 0;
  const pct = (a, p) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))], 0);
  };

  // Unchanged semantics: the same trailing window the old 7-day request covered.
  const days = all.filter((d) => d.day >= isoDate(daysAgo(7)));
  const r = series(days, "readiness"), s = series(days, "sleep");

  // Per-ISO-week averages across the whole window, consumed by buildHistory.
  const buckets = {};
  for (const d of all) {
    const wk = isoWeek(new Date(d.day + "T12:00:00Z"));
    const b = (buckets[wk] = buckets[wk] || { r: [], s: [] });
    if (d.readiness != null) b.r.push(d.readiness);
    if (d.sleep != null) b.s.push(d.sleep);
  }
  const weekly = {};
  for (const wk of Object.keys(buckets)) {
    weekly[wk] = { recAvg7: avg(buckets[wk].r), sleepAvg7: avg(buckets[wk].s) };
  }

  // Long-run context so "rising" and "83" mean something. Percentiles over the
  // full window give a personal normal range; the same calendar month a year ago
  // is the only clean way to separate a seasonal effect from a real decline.
  const allR = series(all, "readiness"), allS = series(all, "sleep");
  const then = new Date();
  const lastYearMonth = `${then.getUTCFullYear() - 1}-${String(then.getUTCMonth() + 1).padStart(2, "0")}`;
  const ly = all.filter((d) => d.day.slice(0, 7) === lastYearMonth);
  const lyR = series(ly, "readiness"), lyS = series(ly, "sleep");

  return {
    days,
    readinessAvg: avg(r),
    readinessMin: r.length ? Math.min.apply(null, r) : null,
    readinessTrend: trend(r),
    sleepAvg: avg(s),
    sleepTrend: trend(s),
    weekly,
    baseline: {
      window_days: RECOVERY_HISTORY_DAYS,
      days_observed: all.length,
      readiness: { p25: pct(allR, 25), median: pct(allR, 50), p75: pct(allR, 75) },
      sleep: { p25: pct(allS, 25), median: pct(allS, 50), p75: pct(allS, 75) },
      // Null rather than a thin average: under 5 days it says nothing.
      same_month_last_year: lyR.length >= 5 || lyS.length >= 5
        ? { month: lastYearMonth, readinessAvg: avg(lyR), sleepAvg: avg(lyS), days: ly.length }
        : null,
    },
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

// Precomputed intake/weight stats plus a 28-day row window. The Worker does the
// averaging, regression and TDEE inference so both consumers see identical
// numbers and neither the coach model nor the chat model does arithmetic.
async function nutrition() {
  if (!INGEST_TOKEN) return null;
  const res = await fetch(NUTRITION_URL, { headers: { Authorization: `Bearer ${INGEST_TOKEN}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!body || !body.stats || !body.stats.logged_days) return null;
  const cutoff = isoDate(daysAgo(28));
  return {
    stats: body.stats,
    days: (body.rows || []).filter((r) => r.date >= cutoff),
  };
}

// The lean-vs-fat split of the weight trend. Every figure, including the verdict
// and its suppression, is computed in the Worker so the coach and the chat bot
// cannot disagree and neither model does arithmetic. Returns null rather than
// throwing on a not-yet-connected account, since that is a normal state.
// Two independent things arrive on one response and are gated SEPARATELY on
// purpose. The recent composition window can be empty while the long bodyweight
// history is rich: he recorded nothing at all in April or May 2026 but has 206
// weigh-ins back to March 2024. Gating both on stats.readings would throw away
// two years of weight every time he skips a month.
async function bodyComposition() {
  if (!INGEST_TOKEN) return null;
  const res = await fetch(BODY_URL, { headers: { Authorization: `Bearer ${INGEST_TOKEN}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const b = await res.json();
  if (!b || !b.connected) return { stats: null, weightHistory: null };
  return {
    stats: b.stats && b.stats.readings ? b.stats : null,
    weightHistory: b.weight_history && b.weight_history.weigh_ins ? b.weight_history : null,
  };
}

// The weekly plan, revised 2026-07-29. Sunday-indexed to match getUTCDay().
//
// The arrangement is deliberate, not arbitrary. Hard intervals sit NEXT TO the
// rest day so they are bounded by rest on one side and an upper day on the other,
// touching no leg session either side; an earlier draft put them the day after
// Lower A, which he rightly rejected. The long easy run follows Saturday's Lower B
// rather than preceding a leg day, because running before squats compromises the
// session that actually drives quad growth. Legs land Tue and Sat (4 days then 3),
// upper Mon and Fri (4 then 3), both inside the productive window.
//
// Six sessions in seven days means six CONSECUTIVE training days (Thu-Tue) is by
// design, not a warning sign. The rest rule's streak threshold accounts for this.
// HYBRID by design: the weekday says what today SHOULD be, but a missed session
// is never skipped, it goes to the front of the queue. Pure weekdays are what
// produced chest at 4 sets/wk before the July rebuild, because a named day is
// skippable while a queue position is not.
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_PLAN = {
  0: "Run (long easy)", 1: "Upper A", 2: "Lower A", 3: "Rest",
  4: "Run (hard intervals)", 5: "Upper B", 6: "Lower B",
};
const CYCLE_SESSIONS = ["Upper A", "Lower A", "Upper B", "Lower B"];

// Weekday arithmetic is computed HERE and never by the model: it has a proven
// habit of shifting weekdays by one when it derives them from a date itself.
function cycleStatus(strength) {
  const now = new Date();
  const dow = now.getUTCDay();
  const daysSince = {};
  for (const name of CYCLE_SESSIONS) {
    const hit = (strength || [])
      .filter((s) => s.title && s.date && s.title.toLowerCase().includes(name.toLowerCase()))
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    daysSince[name] = hit
      ? Math.round((new Date(isoDate(now) + "T00:00:00Z") - new Date(hit.date + "T00:00:00Z")) / 86400000)
      : null;
  }
  // Never performed sorts ahead of everything: it is the most overdue there is.
  const overdue = [...CYCLE_SESSIONS].sort(
    (a, b) => (daysSince[b] == null ? 1e6 : daysSince[b]) - (daysSince[a] == null ? 1e6 : daysSince[a])
  );
  return {
    today: isoDate(now),
    today_is: DOW[dow],
    scheduled_today: WEEK_PLAN[dow],
    scheduled_tomorrow: WEEK_PLAN[(dow + 1) % 7],
    plan: Object.fromEntries(Object.keys(WEEK_PLAN).map((k) => [DOW[k], WEEK_PLAN[k]])),
    days_since_session: daysSince,
    most_overdue: overdue[0],
    // The last 8 sessions are the only window, so anything beyond that reads as
    // null rather than as a large number.
    lookback_sessions: (strength || []).length,
  };
}

// A rest day is a day with NO lifting session and NO run. Computed here, not left
// to the model: it is a set intersection across two sources plus date arithmetic,
// which is exactly the shape of question a model answers confidently and wrongly.
//
// TODAY IS EXCLUDED throughout. An untrained day that is still in progress is not
// a rest day, it is an unfinished one, and counting it would let him "meet" the
// target every morning before he has done anything. Same lesson as the partial
// nutrition day that once reported him 800 kcal under.
function restDays(strength, runs, sourcesOk) {
  const trained = new Set();
  for (const s of strength || []) if (s.date) trained.add(s.date);
  for (const r of runs || []) if (r.day) trained.add(r.day);

  const window = [];
  for (let i = 1; i <= 7; i++) window.push(isoDate(daysAgo(i)));
  const rest = window.filter((d) => !trained.has(d));

  // Consecutive trained days ending yesterday, and how long since the last full
  // rest day. Both walk back 30 days, which is far past anything actionable.
  let streak = 0;
  for (let i = 1; i <= 30; i++) {
    if (trained.has(isoDate(daysAgo(i)))) streak++;
    else break;
  }
  let sinceRest = null;
  for (let i = 1; i <= 30; i++) {
    if (!trained.has(isoDate(daysAgo(i)))) { sinceRest = i; break; }
  }

  return {
    window_days: 7,
    excludes_today: true,
    rest_days: rest.length,
    rest_dates: rest,
    trained_days: 7 - rest.length,
    consecutive_training_days: streak,
    days_since_rest_day: sinceRest,
    target: "at least 1 complete rest day (no lifting, no run) in every 7 days",
    // A failed source makes trained days INVISIBLE, which inflates rest days and
    // would quietly report a perfect rest week during an outage. Absence of data
    // is not evidence of rest, so the verdict is withheld rather than guessed.
    sources_complete: !!sourcesOk,
    meets_target: sourcesOk ? rest.length >= 1 : null,
    ...(sourcesOk ? {} : {
      note: "a data source failed this run, so trained days may be missing and rest days overcounted; draw no conclusion about rest this week",
    }),
  };
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
    nutrition: null,
    body_comp: null,
    weight_history: null,
    rest: null,
    cycle: null,
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
    nutrition().then((r) => (out.nutrition = r)).catch((e) => errors.push(`nutrition: ${e.message}`)),
    bodyComposition().then((r) => {
      out.body_comp = r ? r.stats : null;
      out.weight_history = r ? r.weightHistory : null;
    }).catch((e) => errors.push(`body_comp: ${e.message}`)),
  ];

  await Promise.all(tasks);

  // Needs both sources, so it runs after the fan-out rather than inside it, and
  // it must know whether either source failed: a missing run day looks exactly
  // like a rest day.
  const restSourcesOk =
    !errors.some((e) => e.startsWith("hevy")) && !errors.some((e) => e.startsWith("oura_runs"));
  out.rest = restDays(out.strength, out.runs, restSourcesOk);
  out.cycle = cycleStatus(out.strength);

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
    history = buildHistory(history, out.coach.weeklyRaw, out.runs, runsOk, out.recovery7);
    delete out.coach.weeklyRaw; // lives in out.history, no need to ship twice
    encryptToFile("history.json.enc", history, key);
  }
  out.history = history;

  // The per-week map has been folded into out.history, which is the shape the
  // coach actually reads. Shipping both would bloat the payload with duplicates.
  const recWeeks = out.recovery7 && out.recovery7.weekly ? Object.keys(out.recovery7.weekly).length : 0;
  const recFilled = history.filter((h) => h.recAvg7 != null).length;
  if (out.recovery7) delete out.recovery7.weekly;

  // Encrypt before committing: the repo is public, so only ciphertext is ever
  // written to disk or logs.
  encryptToFile("fitness.json.enc", out, key);

  // Log counts only - never the values, since Actions logs are public.
  const activeLifts = out.coach ? out.coach.lifts.filter((l) => l.active).length : 0;
  console.log(
    `Wrote fitness.json.enc: strength=${out.strength.length} runs=${out.runs.length} ` +
      `readiness=${out.readiness ? "ok" : "missing"} sleep=${out.sleep ? "ok" : "missing"} ` +
      `recovery=${out.recovery7 ? `ok(${out.recovery7.baseline.days_observed}d ${recWeeks}wk)` : "missing"} ` +
      `histRecovery=${recFilled}/${out.history.length}wk ` +
      `coach=${out.coach ? `ok(${activeLifts} active lifts)` : "missing"} ` +
      `nutrition=${out.nutrition ? `ok(${out.nutrition.days.length}d)` : INGEST_TOKEN ? "none" : "off"} ` +
      `body_comp=${out.body_comp ? `ok(${out.body_comp.readings} readings)` : INGEST_TOKEN ? "none" : "off"} ` +
      `weight_history=${out.weight_history ? `ok(${out.weight_history.weigh_ins} weigh-ins, ${out.weight_history.monthly.length}mo)` : "none"} ` +
      `rest=${out.rest.rest_days}/7d${out.rest.meets_target === false ? " BELOW TARGET" : ""} ` +
      `cycle=${out.cycle.today_is}:${out.cycle.scheduled_today} overdue=${out.cycle.most_overdue} ` +
      `history=${out.history.length}wk errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
