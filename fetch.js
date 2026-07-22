#!/usr/bin/env node
// Fetches a compact fitness snapshot from Hevy + Oura and writes fitness.json.
// Runs in GitHub Actions (which has open internet); the daily-brief cloud
// routine, which cannot reach Hevy/Oura directly, reads the committed file.
//
// Tokens come from env (GitHub Actions secrets): HEVY_API_KEY, OURA_TOKEN.
// Node 18+ (built-in fetch).

const fs = require("fs");

const HEVY_KEY = process.env.HEVY_API_KEY;
const OURA_TOKEN = process.env.OURA_TOKEN;
const OURA = "https://api.ouraring.com/v2/usercollection";

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
  const data = await getJSON(
    "https://api.hevyapp.com/v1/workouts?page=1&pageSize=8",
    { "api-key": HEVY_KEY }
  );
  return (data.workouts || []).map((w) => ({
    date: (w.start_time || "").slice(0, 10),
    title: w.title,
  }));
}

async function ouraRuns() {
  const data = await getJSON(
    `${OURA}/workout?${ouraRange(10)}`,
    { Authorization: `Bearer ${OURA_TOKEN}` }
  );
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
  const data = await getJSON(
    `${OURA}/${endpoint}?${ouraRange(startDaysAgo)}`,
    { Authorization: `Bearer ${OURA_TOKEN}` }
  );
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
    errors,
  };

  const tasks = [
    hevyStrength().then((r) => (out.strength = r)).catch((e) => errors.push(`hevy: ${e.message}`)),
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
  console.log(
    `Wrote fitness.json.enc: strength=${out.strength.length} runs=${out.runs.length} ` +
      `readiness=${out.readiness ? "ok" : "missing"} sleep=${out.sleep ? "ok" : "missing"} ` +
      `errors=${errors.length}`
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
