#!/usr/bin/env node
// The morning line: one short Slack DM saying what today is, whether a session
// is overdue, how recovery sits against HIS normal range, and whether a rest day
// is owed. The weekly coach is a Monday verdict; this is the daily nudge.
//
// Deliberately NOT written by a model. Every figure is already computed in
// fetch.js (cycle, rest, recovery baseline), so this only arranges them, costs
// nothing to run, and cannot invent a number.
//
// It is triggered by a repository_dispatch from the Worker (see daily.yml), not
// by a GitHub cron: GitHub runs "05:00" crons around noon, and a morning line
// that arrives after lunch is worse than none. For the same reason it refuses to
// send after LATEST_HOUR local time unless FORCE_SEND=1.
//
// Env: FITNESS_KEY (required), SLACK_BOT_TOKEN. DRY_RUN=1 prints instead.
// Logs status only, never content: Actions logs on a public repo are public.

const lib = require("./breathing-lib");

const STHLM = "Europe/Stockholm";
const LATEST_HOUR = 11;

const stockholmToday = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: STHLM });
const stockholmHour = (now = new Date()) =>
  parseInt(now.toLocaleTimeString("en-GB", { timeZone: STHLM, hour: "2-digit", hour12: false }), 10) % 24;

// Where a score sits in his own p25-p75 band. A bare "78" means nothing; "below
// your normal 80-88" does.
function versusNormal(score, band) {
  if (score == null || !band || band.p25 == null || band.p75 == null) return "";
  const range = `${band.p25}-${band.p75}`;
  if (score < band.p25) return ` (below your normal ${range})`;
  if (score > band.p75) return ` (above your normal ${range})`;
  return ` (normal ${range})`;
}

// Pure: snapshot + today's date in, message out (or null when there is nothing
// trustworthy to say). Tested in test/daily.test.js.
function composeDaily(snap, today) {
  if (!snap || !snap.cycle || snap.cycle.today !== today) return null; // stale snapshot
  const c = snap.cycle;
  const hevyOk = !(snap.errors || []).some((e) => String(e).startsWith("hevy"));
  const rest = snap.rest || {};
  const restOwed = rest.meets_target === false;

  const lines = [`*${c.today_is}: ${c.scheduled_today}*`];

  // A rest day owed outranks whatever the calendar says.
  if (restOwed) {
    lines.push(`- No rest day in ${rest.consecutive_training_days} days: take one today, before the next session.`);
  } else if (hevyOk && c.most_overdue && c.most_overdue !== c.scheduled_today) {
    // Only when a session is actually behind: each comes round every 7 days, so
    // 8+ days (or never, within the lookback) means it was skipped.
    const d = c.days_since_session ? c.days_since_session[c.most_overdue] : null;
    if (d == null) lines.push(`- Overdue: ${c.most_overdue} has not been done in your last ${c.lookback_sessions} sessions. It goes first.`);
    else if (d >= 8) lines.push(`- Overdue: ${c.most_overdue}, ${d} days since the last one. It goes first.`);
  }

  // Recovery, only when the ring has synced TODAY's row. Yesterday's score
  // presented as this morning's is the mistake the coach prompt also forbids.
  const base = (snap.recovery7 && snap.recovery7.baseline) || {};
  const r = snap.readiness, s = snap.sleep;
  if (r && r.day === today && r.score != null) {
    let line = `- Readiness ${r.score}${versusNormal(r.score, base.readiness)}`;
    if (s && s.day === today && s.score != null) line += `, sleep ${s.score}${versusNormal(s.score, base.sleep)}`;
    lines.push(line + ".");
    const low = base.readiness && base.readiness.p25 != null && r.score < base.readiness.p25;
    if (low && !restOwed && !/^rest$/i.test(c.scheduled_today)) {
      lines.push("- Recovery is under your usual range: hold weights today rather than pushing them.");
    }
  } else if (!(snap.errors || []).some((e) => String(e).startsWith("oura"))) {
    // Only when Oura answered and simply has no row for today. If Oura itself
    // failed, blaming the ring would be a guess, so the line is dropped.
    lines.push("- Readiness: ring not synced yet.");
  }

  lines.push(`- Tomorrow: ${c.scheduled_tomorrow}.`);
  return lines.join("\n");
}

async function main() {
  if (!process.env.FITNESS_KEY) { console.error("FITNESS_KEY not set"); process.exit(1); }
  const hour = stockholmHour();
  if (hour >= LATEST_HOUR && process.env.FORCE_SEND !== "1") {
    console.log(`local hour ${hour} is past ${LATEST_HOUR}:00; a morning line this late is noise, not sent`);
    return;
  }
  const snap = lib.decryptFile("fitness.json.enc", lib.keyFromPassphrase(process.env.FITNESS_KEY));
  const msg = composeDaily(snap, stockholmToday());
  if (!msg) { console.log("snapshot is not from today; nothing sent"); return; }
  await lib.postSlack(msg);
  console.log(`daily line sent (lines=${msg.split("\n").length})`);
}

if (require.main === module) {
  main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
}

module.exports = { composeDaily, versusNormal, stockholmHour, stockholmToday };
