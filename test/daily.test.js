const test = require("node:test");
const assert = require("node:assert");
const d = require("../daily");
const f = require("../fetch");

const FRI = "2026-11-13";
const lift = (date, title) => ({ date, title });
const base = { readiness: { p25: 78, median: 83, p75: 88 }, sleep: { p25: 75, median: 80, p75: 86 } };
function snap(over = {}) {
  const strength = [lift("2026-11-10", "Lower A"), lift("2026-11-09", "Upper A"), lift("2026-11-07", "Lower B"), lift("2026-11-06", "Upper B")];
  return {
    errors: [], cycle: f.cycleStatus(strength, FRI), rest: { meets_target: true, consecutive_training_days: 2 },
    readiness: { day: FRI, score: 84 }, sleep: { day: FRI, score: 81 }, recovery7: { baseline: base }, ...over,
  };
}

test("on-plan morning: today, recovery against his own range, tomorrow", () => {
  assert.strictEqual(d.composeDaily(snap(), FRI),
    "*Friday: Upper B*\n- Readiness 84 (normal 78-88), sleep 81 (normal 75-86).\n- Tomorrow: Lower B.");
});

test("an overdue session is named only when it is actually behind", () => {
  const strength = [lift("2026-11-12", "Upper B"), lift("2026-11-09", "Upper A"), lift("2026-11-07", "Lower B"), lift("2026-10-31", "Lower A")];
  const msg = d.composeDaily(snap({ cycle: f.cycleStatus(strength, FRI) }), FRI);
  assert.match(msg, /Overdue: Lower A, 13 days since the last one/);
  assert.doesNotMatch(d.composeDaily(snap(), FRI), /Overdue/);
});

test("a rest day owed outranks the overdue session", () => {
  const msg = d.composeDaily(snap({ rest: { meets_target: false, consecutive_training_days: 9 } }), FRI);
  assert.match(msg, /No rest day in 9 days/);
  assert.doesNotMatch(msg, /Overdue/);
});

test("yesterday's score is never presented as this morning's", () => {
  const msg = d.composeDaily(snap({ readiness: { day: "2026-11-12", score: 90 } }), FRI);
  assert.match(msg, /ring not synced yet/);
  assert.doesNotMatch(msg, /90/);
});

test("low readiness adds one line; a Hevy outage suppresses the overdue claim", () => {
  assert.match(d.composeDaily(snap({ readiness: { day: FRI, score: 70 } }), FRI), /below your normal 78-88.*\n- Recovery is under your usual range/);
  const blind = snap({ errors: ["hevy: 500"], cycle: f.cycleStatus([], FRI) });
  assert.doesNotMatch(d.composeDaily(blind, FRI), /Overdue/);
});

test("a stale snapshot sends nothing", () => {
  assert.strictEqual(d.composeDaily(snap(), "2026-11-14"), null);
  assert.strictEqual(d.composeDaily(null, FRI), null);
});

test("stockholmHour follows local time across DST", () => {
  assert.strictEqual(d.stockholmHour(new Date("2026-11-11T06:05:00Z")), 7);  // CET
  assert.strictEqual(d.stockholmHour(new Date("2026-07-11T06:05:00Z")), 8);  // CEST
  assert.strictEqual(d.stockholmHour(new Date("2026-11-11T23:30:00Z")), 0);
});
