#!/usr/bin/env node
// Polls Oura for meditation/breathing sessions and writes meditation.json.enc.
// Runs every ~20 min in GitHub Actions; the hourly "Meditation summary" cloud
// routine (claude.ai) decrypts the file and DMs Wilhelm when a NEW session has
// appeared since its previous run.
//
// "New" is tracked via first_seen: every session id keeps the timestamp of the
// relay run that first saw it. On the very first run (no previous file) all
// sessions get first_seen = epoch so the routine never floods old history.
//
// Env (GitHub Actions secrets): OURA_TOKEN, FITNESS_KEY. Node 18+.

const fs = require("fs");
const crypto = require("crypto");

const OURA = "https://api.ouraring.com/v2/usercollection";
const OURA_TOKEN = process.env.OURA_TOKEN;
const OUT_FILE = "meditation.json.enc";
const LOOKBACK_DAYS = 21; // enough history for "vs your usual" comparisons
const EPOCH = "1970-01-01T00:00:00Z";

// ---- crypto helpers (same scheme as fetch.js) ------------------------------
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

const round = (n, d = 0) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const isoDate = (d) => d.toISOString().slice(0, 10);

// Oura treats end_date as EXCLUSIVE, so push it to tomorrow to include today.
function ouraRange(startDaysAgo) {
  const start = isoDate(new Date(Date.now() - startDaysAgo * 86400000));
  const end = isoDate(new Date(Date.now() + 86400000));
  return `start_date=${start}&end_date=${end}`;
}

async function getJSON(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Downsample a 5s-interval series into n bucket averages (for a shape readout).
function curve(items, n = 12) {
  const vals = (items || []).filter((v) => v != null && v > 0);
  if (vals.length < n) return null;
  const size = vals.length / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(round(avg(vals.slice(Math.floor(i * size), Math.floor((i + 1) * size))), 1));
  }
  return out;
}

// Stats over one 5s-interval series: avg, min/max, first-minute vs last-minute.
function seriesStats(ts, higherIsCalmer) {
  const vals = ((ts && ts.items) || []).filter((v) => v != null && v > 0);
  if (vals.length < 24) return null; // need at least ~2 min of data
  const first = avg(vals.slice(0, 12)); // first 60s at 5s interval
  const last = avg(vals.slice(-12)); // last 60s
  const changePct = first ? round(((last - first) / first) * 100, 1) : null;
  return {
    avg: round(avg(vals), 1),
    min: Math.min.apply(null, vals),
    max: Math.max.apply(null, vals),
    start: round(first, 1),
    end: round(last, 1),
    change_pct: changePct, // negative HR change / positive HRV change = settling
    curve: curve(vals),
  };
}

function toCompact(s) {
  const durMin =
    s.start_datetime && s.end_datetime
      ? round((new Date(s.end_datetime) - new Date(s.start_datetime)) / 60000, 1)
      : null;
  return {
    id: s.id,
    type: s.type,
    day: s.day,
    start: s.start_datetime,
    end: s.end_datetime,
    duration_min: durMin,
    mood: s.mood || null,
    hr: seriesStats(s.heart_rate),
    hrv: seriesStats(s.heart_rate_variability),
  };
}

// Consecutive days with at least one session, counting back from the most
// recent session day.
function streakDays(days) {
  const uniq = [...new Set(days)].sort().reverse();
  if (!uniq.length) return 0;
  let streak = 1;
  for (let i = 1; i < uniq.length; i++) {
    const prev = new Date(uniq[i - 1] + "T12:00:00Z");
    const cur = new Date(uniq[i] + "T12:00:00Z");
    if (round((prev - cur) / 86400000) === 1) streak++;
    else break;
  }
  return streak;
}

async function main() {
  const passphrase = process.env.FITNESS_KEY;
  if (!passphrase) {
    console.error("FITNESS_KEY is not set. Refusing to write plaintext.");
    process.exit(1);
  }
  if (!OURA_TOKEN) {
    console.error("OURA_TOKEN is not set.");
    process.exit(1);
  }
  const key = keyFromPassphrase(passphrase);

  // Previous first_seen map (bootstrap: empty file -> everything is "old").
  let prevSeen = null; // null = first ever run
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = decryptFile(OUT_FILE, key);
      prevSeen = {};
      for (const s of prev.sessions || []) prevSeen[s.id] = s.first_seen || EPOCH;
    } catch (e) {
      // Unreadable previous file: treat as bootstrap so we never flood.
      console.error(`prev_read: ${e.message} (treating as bootstrap)`);
      prevSeen = null;
    }
  }

  const data = await getJSON(`${OURA}/session?${ouraRange(LOOKBACK_DAYS)}`, {
    Authorization: `Bearer ${OURA_TOKEN}`,
  });
  const raw = (data.data || []).filter((s) => s.start_datetime);
  raw.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));

  const now = new Date().toISOString();
  const sessions = raw.map((s) => {
    const c = toCompact(s);
    c.first_seen = prevSeen === null ? EPOCH : prevSeen[s.id] || now;
    return c;
  });

  // Test hook (workflow_dispatch input): pretend the latest session just
  // appeared, so the notifier routine can be exercised end-to-end.
  if (process.env.MARK_LATEST_NEW === "1" && sessions.length) {
    sessions[sessions.length - 1].first_seen = now;
    console.log("MARK_LATEST_NEW: latest session re-marked as new");
  }

  const last30 = sessions; // window is 21d, close enough for "recent usual"
  const hrDrops = last30.map((s) => s.hr && s.hr.change_pct).filter((v) => v != null);
  const hrvAvgs = last30.map((s) => s.hrv && s.hrv.avg).filter((v) => v != null);
  const durs = last30.map((s) => s.duration_min).filter((v) => v != null);
  const today = isoDate(new Date());
  const weekAgo = isoDate(new Date(Date.now() - 6 * 86400000));

  const out = {
    generated_at: now,
    window_days: LOOKBACK_DAYS,
    sessions,
    stats: {
      sessions_in_window: sessions.length,
      sessions_last7: sessions.filter((s) => s.day >= weekAgo).length,
      sessions_today: sessions.filter((s) => s.day === today).length,
      streak_days: streakDays(sessions.map((s) => s.day)),
      avg_duration_min: durs.length ? round(avg(durs), 1) : null,
      avg_hr_change_pct: hrDrops.length ? round(avg(hrDrops), 1) : null,
      avg_hrv: hrvAvgs.length ? round(avg(hrvAvgs), 1) : null,
    },
  };

  encryptToFile(OUT_FILE, out, key);

  // Log counts only - never values, since Actions logs are public.
  const fresh = sessions.filter((s) => s.first_seen === now).length;
  console.log(
    `Wrote ${OUT_FILE}: sessions=${sessions.length} new_this_run=${fresh}` +
      (prevSeen === null ? " (bootstrap: all marked old)" : "")
  );
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
