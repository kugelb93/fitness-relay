// The training programme, read from program.json: the ONE place the weekly
// plan, the session contents and the designed set counts are written down.
// fetch.js takes the weekday plan and cycle from here and coach.js renders the
// prompt's programme text from here, so changing the split is a one-file edit
// instead of a hunt through a 2,000-word prompt and a lookup table that have to
// be kept in agreement by hand.
//
// temporary_rules is for coaching rules that are only true for a while ("the
// 28-day window still shows the old split"). Each carries an `expires` date and
// simply stops being sent after it. Two such rules sat in the prompt for three
// months past their stated end date before this existed.

const fs = require("fs");
const path = require("path");

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function load(file = path.join(__dirname, "program.json")) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const d of DOW) if (!p.week || !p.week[d]) throw new Error(`program.json: week.${d} missing`);
  for (const name of p.cycle || []) {
    if (!p.sessions || !p.sessions[name]) throw new Error(`program.json: cycle session "${name}" has no entry in sessions`);
    if (!Object.values(p.week).includes(name)) throw new Error(`program.json: cycle session "${name}" is not scheduled on any weekday`);
  }
  return p;
}

// Sunday-indexed, matching Date#getUTCDay().
function weekPlan(p) {
  return Object.fromEntries(DOW.map((d, i) => [i, p.week[d]]));
}

// "Sun run (long easy), Mon Upper A, ..., Wed REST, ..."
function scheduleText(p) {
  const label = (s) => (/^rest$/i.test(s) ? "REST" : /^run\b/i.test(s) ? s.replace(/^Run/, "run") : s);
  return DOW.map((d) => `${d.slice(0, 3)} ${label(p.week[d])}`).join(", ");
}

// "Lower A = Squat 3, Deadlift 3 (note), ... Upper A = ..."
function sessionsText(p) {
  return Object.keys(p.sessions)
    .map((name) => `${name} = ` + p.sessions[name]
      .map((e) => `${e.name} ${e.sets}${e.note ? ` (${e.note})` : ""}`).join(", ") + ".")
    .join(" ");
}

// "quads 13, chest 13, shoulders 12 (note), ..."
function designedSetsText(p) {
  return (p.designed_weekly_sets || [])
    .map((g) => `${g.group} ${g.sets}${g.note ? ` (${g.note})` : ""}`).join(", ");
}

// Rules still in force on `today` (YYYY-MM-DD). expires is the last day the
// rule applies; a rule with no expires never lapses and does not belong here.
function activeRules(p, today) {
  return (p.temporary_rules || []).filter((r) => r && r.text && (!r.expires || r.expires >= today));
}

function temporaryRulesText(p, today) {
  const rules = activeRules(p, today);
  if (!rules.length) return "";
  return "\n" + rules.map((r) => `- TEMPORARY (lapses after ${r.expires}): ${r.text}`).join("\n");
}

module.exports = { DOW, load, weekPlan, scheduleText, sessionsText, designedSetsText, activeRules, temporaryRulesText };
