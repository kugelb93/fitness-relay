#!/usr/bin/env node
// Fetches a compact fitness snapshot from Hevy + Oura and writes fitness.json.
// Runs in GitHub Actions (which has open internet); the daily-brief cloud
// routine, which cannot reach Hevy/Oura directly, reads the committed file.
//
// It also computes the full weekly-coach analysis (all workout history:
// per-lift e1RM progression, PRs, stalls, muscle balance) under `coach`, so the
// weekly lifting-coach routine can decrypt and coach without ever calling Hevy.
//
// Tokens come from env (GitHub Actions secrets): HEVY_API_KEY, OURA_TOKEN.
// Node 18+ (built-in fetch).

const fs = require("fs");

const HEVY_KEY = process.env.HEVY_API_KEY;
const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA = "https://api.ouraring.com/v2/usercollection";
const HEVY = "https://api.hevyapp.com/v1";
const ACTIVE_DAYS = 35;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
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

// ---- Weekly-coach analysis (mirrors hevy/cloud-routine/coach.js) ----------
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
    const rec = s.slice(-4);
    const tr = rec[0].bestE1rm
      ? round(((rec[rec.length - 1].bestE1rm - rec[0].bestE1rm) / rec[0].bestE1rm) * 100, 1)
      : 0;
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
// ---------------------------------------------------------------------------

async function ouraRuns() {
  const data = await getJSON(`${OURA}/workout?${ouraRange(10)}`, { Authorization: `Bearer ${OURA_TOKEN}` });
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
  const errors = [];
  const out = {
    generated_at: new Date().toISOString(),
    strength: [],
    runs: [],
    readiness: null,
    sleep: null,
    coach: null,
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

  // Encrypt before committing: the repo is public, so only the ciphertext is
  // ever written to disk or logs. Key = sha256(passphrase); output is
  // base64(iv || AES-256-CBC ciphertext). The brief routine holds the same
  // passphrase and reverses this.
  const passphrase = process.env.FITNESS_KEY;
  if (!passphrase) {
    console.error("FITNESS_KEY is not set. Refusing to write plaintext.");
    process.exit(1);
  }
  const crypto = require("crypto");
  const key = crypto.createHash("sha256").update(passphrase).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(out), "utf8"), cipher.final()]);
  fs.writeFileSync("fitness.json.enc", Buffer.concat([iv, enc]).toString("base64") + "\n");

  // Log counts only - never the values, since Actions logs are public.
  const activeLifts = out.coach ? out.coach.lifts.filter((l) => l.active).length : 0;
  console.log(
    `Wrote fitness.json.enc: strength=${out.strength.length} runs=${out.runs.length} ` +
      `readiness=${out.readiness ? "ok" : "missing"} sleep=${out.sleep ? "ok" : "missing"} ` +
      `coach=${out.coach ? `ok(${activeLifts} active lifts)` : "missing"} errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
