const test = require("node:test");
const assert = require("node:assert");
const program = require("../program");
const coach = require("../coach");

const p = program.load();

test("program.json is internally consistent", () => {
  assert.strictEqual(Object.keys(program.weekPlan(p)).length, 7);
  for (const name of p.cycle) assert.ok(p.sessions[name].length > 0);
  // The designed set counts must follow from the sessions, not drift from them.
  const sets = (re) => Object.values(p.sessions).flat().filter((e) => re.test(e.name)).reduce((n, e) => n + e.sets, 0);
  const designed = Object.fromEntries(p.designed_weekly_sets.map((g) => [g.group, g.sets]));
  assert.strictEqual(sets(/Bench|Fly|Pec Deck/), designed.chest);
  assert.strictEqual(sets(/Squat|Leg Extension/), designed.quads);
  assert.strictEqual(sets(/Curl/), designed.biceps);
  assert.strictEqual(sets(/Triceps/), designed.triceps);
  assert.strictEqual(sets(/Calf/), designed.calves);
});

test("the coach prompt is rendered from the config", () => {
  assert.ok(coach.SYSTEM.includes(program.scheduleText(p)));
  assert.ok(coach.SYSTEM.includes(program.sessionsText(p)));
  assert.ok(coach.SYSTEM.includes(program.designedSetsText(p)));
  assert.match(program.scheduleText(p), /^Sun run \(long easy\), Mon Upper A, .*Wed REST/);
  assert.doesNotMatch(coach.SYSTEM, /undefined|\[object Object\]/);
});

test("temporary rules lapse after their expiry date", () => {
  const q = { temporary_rules: [{ text: "old split still in the window", expires: "2026-08-31" }, { text: "travel week", expires: "2026-11-20" }] };
  assert.deepStrictEqual(program.activeRules(q, "2026-11-11").map((r) => r.text), ["travel week"]);
  assert.strictEqual(program.activeRules(q, "2026-11-20").length, 1, "expiry day itself still counts");
  assert.strictEqual(program.activeRules(q, "2026-11-21").length, 0);
  assert.strictEqual(program.temporaryRulesText(q, "2026-12-01"), "");
  assert.match(program.temporaryRulesText(q, "2026-11-11"), /TEMPORARY \(lapses after 2026-11-20\): travel week/);
});
