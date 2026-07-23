#!/usr/bin/env node
// Weekly breathing digest, run in GitHub Actions on a Sunday-evening cron.
// Reads the encrypted snapshot, summarizes the last 7 days (vs the prior two
// weeks in the 21-day window), composes a digest (Claude or template), and
// posts one Slack message. Always sends exactly one message, even a zero week.
//
// Env: FITNESS_KEY (required). SLACK_BOT_TOKEN, ANTHROPIC_API_KEY optional.
// DRY_RUN=1 prints instead of sending.

const fs = require("fs");
const lib = require("./breathing-lib");
const { avg, r1 } = lib;

const MED = "meditation.json.enc";

function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

function holdsOf(s) {
  const iv = (s.hr && s.hr.series) ? (s.hr.interval_s || 5) : 60;
  return lib.threeHolds((s.hr && s.hr.series) || (s.hr && s.hr.minutes) || [], iv);
}

async function main() {
  const pass = process.env.FITNESS_KEY;
  if (!pass) { console.error("FITNESS_KEY not set"); process.exit(1); }
  const key = lib.keyFromPassphrase(pass);
  if (!fs.existsSync(MED)) { await lib.postSlack("Weekly breathing digest: no data available this week, will retry next Sunday."); return; }

  const snap = lib.decryptFile(MED, key);
  const sessions = (snap.sessions || []).filter((s) => s.day);
  const from = isoDaysAgo(6), to = new Date().toISOString().slice(0, 10);
  const week = sessions.filter((s) => s.day >= from);
  const prior = sessions.filter((s) => s.day < from); // rest of the 21-day window

  const wh = week.filter((s) => s.practice === "wim_hof");
  const res = week.filter((s) => s.practice === "resonance");

  const d = { from, to, total: week.length, wim_hof: wh.length, resonance: res.length, streak_days: snap.stats && snap.stats.streak_days };

  if (wh.length) {
    const lows = wh.flatMap((s) => holdsOf(s).map((h) => h.hr)).filter((v) => v != null);
    d.wh_deepest = lows.length ? Math.min(...lows) : null;
    d.wh_avg_hold = lows.length ? r1(avg(lows)) : null;
    const pLows = prior.filter((s) => s.practice === "wim_hof").flatMap((s) => holdsOf(s).map((h) => h.hr)).filter((v) => v != null);
    if (pLows.length && d.wh_avg_hold != null) {
      const diff = d.wh_avg_hold - r1(avg(pLows));
      d.wh_trend = diff <= -1 ? "deeper" : diff >= 1 ? "shallower" : "about the same";
    }
  }
  if (res.length) {
    d.res_before2200 = res.filter((s) => lib.localHour(s.start) < 22).length;
    d.res_late = res.filter((s) => lib.localHour(s.start) >= 22).length;
    const lifts = res.map((s) => lib.resonanceMetrics(s).hrv_lift).filter((v) => v != null);
    d.res_hrv_lift = lifts.length ? (avg(lifts) > 0 ? "+" : "") + r1(avg(lifts)) : "n/a";
  }

  // Standout: deepest WH hold, else biggest resonance HRV lift.
  let best = null;
  for (const s of wh) { const lo = Math.min(...holdsOf(s).map((h) => h.hr).concat(Infinity)); if (lo !== Infinity && (!best || lo < best.v)) best = { v: lo, txt: `${s.day} ${s.start.slice(11, 16)} Wim Hof, hold to ${lo} bpm` }; }
  if (!best) for (const s of res) { const l = lib.resonanceMetrics(s).hrv_lift; if (l != null && (!best || l > best.v)) best = { v: l, txt: `${s.day} ${s.start.slice(11, 16)} resonance, HRV lift +${l}` }; }
  d.standout = best && best.txt;

  if (res.length && d.res_late > d.res_before2200) d.nudge = "Try shifting resonance before 22:00 next week, your onset is faster with a buffer before bed.";
  else if (wh.length) d.nudge = "Midday Wim Hof runs your deepest, a good slot to aim for.";

  const msg = await lib.compose("digest", d);
  await lib.postSlack(msg);
  console.log("digest sent:", d.total, "sessions");
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
