// Shared helpers for the breathing notifier + weekly digest that run in
// GitHub Actions. Crypto matches fetch.js/meditation.js (AES-256-CBC, key =
// sha256(FITNESS_KEY), base64(iv||ct)). Analysis mirrors what the old
// claude.ai routines did, so message content is unchanged after the move.

const fs = require("fs");
const crypto = require("crypto");

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function keyFromPassphrase(pass) {
  return crypto.createHash("sha256").update(pass).digest();
}
function decryptFile(path, key) {
  const buf = Buffer.from(fs.readFileSync(path, "utf8").trim(), "base64");
  const dec = crypto.createDecipheriv("aes-256-cbc", key, buf.subarray(0, 16));
  return JSON.parse(Buffer.concat([dec.update(buf.subarray(16)), dec.final()]).toString("utf8"));
}
function encryptToFile(path, obj, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  fs.writeFileSync(path, Buffer.concat([iv, enc]).toString("base64") + "\n");
}

// ---- analysis --------------------------------------------------------------
function interp(items, maxGap) {
  const out = [...items];
  let last = null;
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null && out[i] > 0) {
      if (last != null && i - last > 1 && i - last <= maxGap) {
        for (let j = last + 1; j < i; j++) out[j] = out[last] + (out[i] - out[last]) * (j - last) / (i - last);
      }
      last = i;
    } else out[i] = null;
  }
  return out;
}
function smooth(items, w) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const c = items.slice(Math.max(0, i - w), i + w + 1).filter((v) => v != null);
    out.push(c.length >= w ? avg(c) : null);
  }
  return out;
}

// Wilhelm always does exactly 3 Wim Hof rounds. Find up to 3 deepest HR troughs
// separated by >=120s, skipping the first 60s (settling, not a hold). Fewer
// than 3 visible = sensor gap, not a skipped round.
function threeHolds(hrItems, iv) {
  if (!hrItems || !hrItems.length || !iv) return [];
  const sm = smooth(interp(hrItems, Math.round(20 / iv)), Math.max(1, Math.round(8 / iv)));
  const sep = Math.round(120 / iv), skip = Math.round(60 / iv), win = Math.round(20 / iv);
  const cands = [];
  for (let i = skip; i < sm.length; i++) {
    if (sm[i] == null) continue;
    const seg = sm.slice(Math.max(0, i - win), Math.min(sm.length, i + win)).filter((v) => v != null);
    if (seg.length && sm[i] <= Math.min(...seg) + 0.01) cands.push({ i, v: sm[i] });
  }
  cands.sort((a, b) => a.v - b.v);
  const picked = [];
  for (const c of cands) {
    if (picked.every((p) => Math.abs(p.i - c.i) >= sep)) picked.push(c);
    if (picked.length === 3) break;
  }
  picked.sort((a, b) => a.i - b.i);
  return picked.map((p) => ({ min: r1((p.i * iv) / 60), hr: r1(p.v) }));
}

// Resonance: settle time (first minute HR clearly below start), mid-session
// steadiness (SD), and HRV lift (last third minus first third of hrv minutes).
function resonanceMetrics(s) {
  const hm = (s.hr && s.hr.minutes) || [];
  const vm = (s.hrv && s.hrv.minutes) || [];
  const hmOk = hm.filter((v) => v != null);
  const start = hm[0] != null ? hm[0] : hmOk[0];
  let settle = null;
  for (let m = 1; m < hm.length; m++) if (hm[m] != null && hm[m] <= start - 3) { settle = m; break; }
  const mid = hmOk.slice(1, -1);
  const sd = mid.length > 1 ? r1(Math.sqrt(avg(mid.map((x) => (x - avg(mid)) ** 2)))) : null;
  const vmOk = vm.filter((v) => v != null);
  const third = Math.max(1, Math.floor(vmOk.length / 3));
  const lift = vmOk.length >= 3 ? r1(avg(vmOk.slice(-third)) - avg(vmOk.slice(0, third))) : null;
  return { settle_min: settle, steadiness_sd: sd, hrv_lift: lift, hr_start: r1(start), hr_min: hmOk.length ? Math.min(...hmOk) : null };
}

function localHour(iso) { return parseInt(iso.slice(11, 13), 10); }
function timeOfDay(h) { return h < 11 ? "morning" : h < 17 ? "midday" : h < 21 ? "evening" : "late"; }

// Build the compact analysis object handed to the message composer.
function analyzeSession(s, stats) {
  const iv = (s.hr && s.hr.interval_s) || 5;
  const a = {
    practice: s.practice,
    duration_min: s.duration_min,
    start_local: s.start.slice(11, 16),
    hour: localHour(s.start),
    time_of_day: timeOfDay(localHour(s.start)),
    day: s.day,
    hr: { avg: s.hr && s.hr.avg, min: s.hr && s.hr.min, max: s.hr && s.hr.max, start: s.hr && s.hr.start, end: s.hr && s.hr.end },
    hrv: { avg: s.hrv && s.hrv.avg, max: s.hrv && s.hrv.max },
    streak_days: stats && stats.streak_days,
    sessions_today: stats && stats.sessions_today,
    baseline: stats && stats.practices && stats.practices[s.practice],
  };
  if (s.practice === "wim_hof") {
    a.holds = threeHolds((s.hr && s.hr.series) || (s.hr && s.hr.minutes) || [], (s.hr && s.hr.series) ? iv : 60);
  } else {
    a.resonance = resonanceMetrics(s);
  }
  return a;
}

// ---- message composition ---------------------------------------------------
// Prefer Claude (warm, adaptive) when ANTHROPIC_API_KEY is set; otherwise fall
// back to a deterministic template so the pipeline never depends on the API.
async function compose(kind, payload) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await composeViaClaude(kind, payload);
    } catch (e) {
      console.error("Claude compose failed, using template:", e.message);
    }
  }
  return kind === "session" ? templateSession(payload) : templateDigest(payload);
}

const SESSION_SYSTEM = `You write one short Slack DM summarizing a single breathing session for Wilhelm, from a JSON analysis object.
Rules:
- Output ONLY the message. A bold header line, then 4-7 "- " bullets. No preamble, no ref/id line.
- Header: *<Practice>: <duration> min at <HH:MM>* and add " (yesterday, <Mon DD>)" if not_today is true. Practice label: "Wim Hof" or "Resonance".
- ASCII PUNCTUATION ONLY: plain : and , ; no smart quotes, en/em dashes, ellipsis char, or non-breaking spaces. Plain hyphen-space bullets. At most 1 emoji.
- Numbers over adjectives. Warm, direct, specific.
- Wim Hof: he always does exactly 3 rounds. Never state a round count as a finding. Report the visible hold lows (holds[].hr at holds[].min) and which was deepest; note the HRV peak. If fewer than 3 holds are present that is a sensor gap, say which were visible. Below 60 bpm is a deep hold for him, below 50 exceptional.
- Resonance: report settle speed and steadiness, and HRV lift across the session (resonance.hrv_lift, positive = good).
- Compare only to the SAME-practice baseline in baseline.avg_* . Never cross practices.
- Time-of-day feedback from time_of_day: morning=set up the day; midday=afternoon reset and note his midday Wim Hof runs deepest; evening=unwind; late=pre-sleep (resonance supports sleep onset, best before ~22:00 with a 20-30 min buffer, after ~22:30 tends to delay his onset; late Wim Hof is activating, if HR ended high suggest slow breathing before bed).
- Streak bullet only if streak_days >= 2 or sessions_today >= 2.`;

const DIGEST_SYSTEM = `You write one Slack DM: Wilhelm's weekly breathing digest, from a JSON summary.
Rules:
- Output ONLY the message. Header *Your week in breathing: <Mon DD> to <Mon DD>* then 5-8 "- " bullets. No preamble.
- ASCII PUNCTUATION ONLY. Plain hyphen-space bullets. At most 1 emoji. Numbers over adjectives.
- Cover: total sessions (split Wim Hof vs resonance) and streak; Wim Hof deepest+average hold this week vs prior weeks; resonance count, timing split (before 22:00 vs after 22:30) and average HRV lift; the single standout session (day+time+one metric); one gentle specific nudge.
- If zero sessions this week, send a short 2-3 bullet note with a warm nudge.
- Never invent trends; only claims the data supports. Never mention mood.`;

async function composeViaClaude(kind, payload) {
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: kind === "session" ? SESSION_SYSTEM : DIGEST_SYSTEM,
      messages: [{ role: "user", content: "Analysis JSON:\n" + JSON.stringify(payload) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error("empty completion");
  return text;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monDD(day) { const [, m, d] = day.split("-"); return `${MON[+m - 1]} ${+d}`; }

function templateSession(a) {
  const label = a.practice === "wim_hof" ? "Wim Hof" : "Resonance";
  const when = a.not_today ? ` (yesterday, ${monDD(a.day)})` : "";
  const L = [`*${label}: ${Math.round(a.duration_min)} min at ${a.start_local}*${when}`];
  if (a.practice === "wim_hof") {
    const h = a.holds || [];
    if (h.length) {
      const lows = h.map((x) => x.hr);
      const deepIdx = lows.indexOf(Math.min(...lows));
      L.push(`- Holds: lows of ${lows.join(", ")} bpm; round ${deepIdx + 1} was deepest.`);
      if (h.length < 3) L.push(`- Only ${h.length} of 3 holds showed clearly in the data (sensor gap on the rest).`);
    } else {
      L.push(`- Holds: sensor coverage was too sparse to read the retention dips this time.`);
    }
    if (a.hrv.max != null) L.push(`- HRV peaked at ${a.hrv.max} during the session.`);
    if (a.baseline && a.baseline.avg_hrv != null && a.hrv.avg != null)
      L.push(`- Session HRV ${a.hrv.avg} vs your Wim Hof usual of ~${a.baseline.avg_hrv}.`);
  } else {
    const r = a.resonance || {};
    if (r.settle_min != null) L.push(`- Settled about ${r.settle_min} min in, HR down to ${r.hr_min}.`);
    else L.push(`- HR stayed near ${r.hr_start} throughout, little to shed tonight.`);
    if (r.hrv_lift != null) L.push(`- HRV lift across the session: ${r.hrv_lift > 0 ? "+" : ""}${r.hrv_lift} (positive is good).`);
    if (a.baseline && a.baseline.avg_hrv != null && a.hrv.avg != null)
      L.push(`- Session HRV ${a.hrv.avg} vs your resonance usual of ~${a.baseline.avg_hrv}.`);
  }
  const tod = { morning: "Morning session, a good way to set up the day.", midday: "Midday reset. Your midday Wim Hof sessions run your deepest.", evening: "Evening wind-down from the workday.", late: a.practice === "resonance" ? "Pre-sleep. Resonance supports sleep onset, best started before 22:00." : "Late Wim Hof is activating; if you feel wired, a few slow breaths before bed will help." }[a.time_of_day];
  if (tod) L.push(`- ${tod}`);
  if (a.streak_days >= 2) L.push(`- ${a.streak_days}-day streak. :seedling:`);
  else if (a.sessions_today >= 2) L.push(`- 2nd session today.`);
  return L.join("\n");
}

function templateDigest(d) {
  if (!d.total) {
    return `*Your week in breathing: ${monDD(d.from)} to ${monDD(d.to)}*\n- 0 sessions this week.\n- The streak is dormant, an easy one to restart whenever you like. :seedling:`;
  }
  const L = [`*Your week in breathing: ${monDD(d.from)} to ${monDD(d.to)}*`];
  L.push(`- ${d.total} sessions this week (${d.wim_hof} Wim Hof, ${d.resonance} resonance).${d.streak_days >= 2 ? ` ${d.streak_days}-day streak.` : ""}`);
  if (d.wim_hof) L.push(`- Wim Hof: deepest hold ${d.wh_deepest} bpm, average hold ${d.wh_avg_hold} bpm${d.wh_trend ? `, ${d.wh_trend} vs prior weeks` : ""}.`);
  if (d.resonance) L.push(`- Resonance: ${d.res_before2200} before 22:00, ${d.res_late} after 22:30; average HRV lift ${d.res_hrv_lift}.`);
  if (d.standout) L.push(`- Standout: ${d.standout}.`);
  if (d.nudge) L.push(`- ${d.nudge}`);
  return L.join("\n");
}

async function postSlack(text) {
  if (process.env.DRY_RUN === "1") { console.log("---- DRY RUN, would send ----\n" + text + "\n-----------------------------"); return true; }
  if (!process.env.SLACK_BOT_TOKEN) { console.log("SLACK_BOT_TOKEN not set; skipping send. Message was:\n" + text); return false; }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: process.env.SLACK_USER_ID || "U089CRCM8M8", text, mrkdwn: true }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("Slack error: " + j.error);
  return true;
}

module.exports = {
  avg, r1, keyFromPassphrase, decryptFile, encryptToFile,
  analyzeSession, threeHolds, resonanceMetrics, timeOfDay, localHour,
  compose, postSlack, templateSession, templateDigest, monDD,
};
