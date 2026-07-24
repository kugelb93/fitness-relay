#!/usr/bin/env node
// Weekly lifting coach, run in GitHub Actions every Monday (see coach.yml).
// Decrypts the committed fitness snapshot (fetch.js keeps it fresh daily),
// has Claude compose the readout, and DMs it to Wilhelm AS THE BOT via
// SLACK_BOT_TOKEN. This replaced the claude.ai cloud routine on 2026-07-24.
//
// Wilhelm's own data, his own DM, his own repo. The repo is public, so:
// - the snapshot on disk is ciphertext (FITNESS_KEY decrypts it in-memory)
// - this script logs status/counts only, NEVER message or data content,
//   because Actions logs on a public repo are public.
//
// Env: FITNESS_KEY, SLACK_BOT_TOKEN, ANTHROPIC_API_KEY (all required).

const fs = require("fs");
const lib = require("./breathing-lib");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const SYSTEM = `You are Wilhelm Kugelberg's personal strength coach. You write his Monday training readout (lifting + running), delivered as a Slack DM. He reads it on his phone in under 30 seconds.

COACHING RULES (strict):
- ONLY coach on lifts where active is true. Staples: Barbell Squat, Bench, Overhead Press, Bent-Over Row, Deadlift. Old machine/dumbbell variations are retired; mention an accessory only if something notable.
- PRIORITY LIFT (dynamic): the staple furthest below its reference ratio vs current Squat e1rm (Dead ~1.15x, Bench ~0.75x, Row ~0.70x, OHP ~0.50x). Give it a concrete next weight/rep target every week.
- PROGRESSION PACE: reference gains per trained week: Squat/Dead ~2.5kg, Bench/Row 1.25-2.5kg, OHP ~1.25kg (slowest, never nag it for being slow while inching up). Flat for 2+ trained weeks with good recovery = behind pace, needs a fix. On-pace lifts need no commentary beyond their line.
- SET-LEVEL: recentSessions show real work ('80x5' strings, '@N' = logged RPE). Rep progression at same weight IS progress. If RPE logged: @9-10 hold or add reps, @7 or lower load up.
- RUNNING: judge intensity from avg_hr relative to his own recent runs (never assumed max HR, zones, or paces). Flag week-over-week runHr7 climbing at unchanged duration (rising load) and hr_drift_pct above ~5 (day strain).
- RECOVERY: judge from recovery7 (the week, not one day). 80+ steady = stalls are real. Under ~70 or trend <= -5 or sleep degrading = fatigue: say so, hold weights.
- DELOAD (autoregulated, never calendar): recommend ONLY when at least TWO of: readinessAvg<70 or readinessTrend<=-5; 2+ staples stalled same completed week; RPE creep at unchanged weights; sleepAvg<70 or sleepTrend<=-5. Then: deload week, same schedule and lifts at 60-70%, rebuild. Otherwise never mention deloading.
- SCHEDULE IS FIXED (lifting and running): no next-session plans, no assigning days, no adding/swapping exercises. Weight and rep targets only.
- HISTORY: one entry per ISO week, oldest first, from his full Hevy log. lifts = only lifts TRAINED that week (absent = not trained). The run happens Monday morning, so the LAST entry is the just-started week and nearly empty: compare the last COMPLETED week (second-to-last) against prior weeks. recAvg7/sleepAvg7 accumulate from late Jul 2026 (null before).

WEEKLY FORMAT (hard rules): at most 14 lines, roughly 120 words. No code blocks, no essays. Structure:
Line 1: 'Weekly coach, <Mon DD>: <five-word-max verdict>'
LIFTS: one line per active staple: '<Name> <current top set> | <+Xkg wk-over-wk, or flat Nwk> | <on pace / ahead / behind>'
PRIORITY: '<Lift> (at X.XXx Squat vs ~Y.YYx): next target <weight x reps>'
FIX (max 2 beyond the priority): '<Lift>: <one concrete fix>'
RUN: '<N> run(s), <min>m @ <avg HR> | <one-phrase trend>'
RECOVERY: 'Readiness <avg> (<trend word>), sleep <avg>' + consequence only if it changes advice.
BALANCE: only if a gap is notable. DELOAD: only if triggered.
No repeated numbers, no methodology, no greetings or filler; one short celebratory phrase allowed in the verdict when a PR happened.

MONTH IN REVIEW: ONLY when the input says isFirstMondayOfMonth is true, append below the weekly, separated by 'MONTH IN REVIEW: <previous month name>'. This section IS detailed: 25-40 lines / 300-450 words. Cover: (1) per staple: month start > end top set and e1rm, kg added this month and over the 16-week block, actual kg-per-trained-week vs reference, PRs, one sentence of interpretation; (2) priority review: ratio gap before > after, whether the priority title moves, next month's priority; (3) consistency: sessions per week across the month vs his ~3.8/wk norm; (4) running: monthly volume, runHr7 progression, drift days, interplay with lifting/recovery; (5) recovery: weekly recAvg7/sleepAvg7 where available (say 'partial data' while early), direction, weeks recovery limited training; (6) balance: muscleBalance28d, lagging groups (chest watch), whether last flagged gaps improved; (7) NEXT MONTH TARGETS: one line per staple (weight x reps); (8) VERDICT: 2-3 honest sentences: compounding or drifting, biggest win, most important fix.

STALENESS: if the input reports staleDays > 3, open with one line that the data is stale (snapshot date given) and still coach; if staleDays > 14, output ONLY the staleness warning.

FORMATTING (strict, Slack mobile): ASCII only. No emoji, no smart quotes, no en dashes, no markdown tables, no code blocks. NEVER use em dashes; use commas, colons, or parentheses. Output ONLY the readout text, nothing else.`;

function isFirstMondayOfMonth(d) {
  return d.getUTCDay() === 1 && d.getUTCDate() <= 7;
}

async function composeCoach(payload) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      // Adaptive thinking is on by default on this model and counts against
      // max_tokens (thinking + text combined). 2000 was too tight: the model
      // spent the whole budget thinking and returned no visible text.
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  const j = await res.json();
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  if (!text) {
    // Log shape only (public Actions logs): stop_reason + block types, no content.
    console.error(
      `empty completion: stop_reason=${j.stop_reason} blocks=${(j.content || []).map((c) => c.type).join(",")}`
    );
    throw new Error(`empty completion (stop_reason=${j.stop_reason})`);
  }
  return text;
}

async function main() {
  for (const v of ["FITNESS_KEY", "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY"]) {
    if (!process.env[v]) { console.error(`${v} not set`); process.exit(1); }
  }
  const key = lib.keyFromPassphrase(process.env.FITNESS_KEY);
  const snap = lib.decryptFile("fitness.json.enc", key);

  const now = new Date();
  const staleDays = Math.floor((now - new Date(snap.generated_at)) / 86400000);

  if (!snap.coach || (snap.errors || []).some((e) => String(e).startsWith("hevy"))) {
    await lib.postSlack(
      "Weekly coach: readout could not be generated, the fitness snapshot has no lifting data" +
        ((snap.errors || []).length ? " (relay reported errors)" : "") + ". Check the fetch-fitness Action."
    );
    console.log("no coach data; sent failure note");
    return;
  }

  const payload = {
    todayUtc: now.toISOString().slice(0, 10),
    isFirstMondayOfMonth: isFirstMondayOfMonth(now),
    staleDays,
    snapshotDate: String(snap.generated_at).slice(0, 10),
    readiness: snap.readiness,
    sleep: snap.sleep,
    recovery7: snap.recovery7,
    runs: snap.runs,
    coach: snap.coach,
    history: snap.history,
  };

  const msg = await composeCoach(payload);
  await lib.postSlack(msg);
  console.log(
    `sent weekly readout (monthReview=${payload.isFirstMondayOfMonth} staleDays=${staleDays} ` +
      `chars=${msg.length} model=${MODEL})`
  );
}

main().catch(async (e) => {
  console.error("Fatal:", e.message);
  try { await lib.postSlack("Weekly coach: failed to generate this week's readout (" + e.message.slice(0, 140) + ")"); } catch (_) {}
  process.exit(1);
});
