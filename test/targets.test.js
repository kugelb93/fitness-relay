const test = require("node:test");
const assert = require("node:assert");
const t = require("../targets");
const coach = require("../coach");

const WEEK = "2026-W45"; // Mon 2 Nov .. Sun 8 Nov 2026

test("weekDates returns Monday to Sunday, including across a year boundary", () => {
  assert.deepStrictEqual(t.weekDates(WEEK), ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.strictEqual(t.weekDates("2027-W01")[0], "2027-01-04");
  assert.strictEqual(t.weekDates("2026-W53")[6], "2027-01-03");
  assert.deepStrictEqual(t.weekDates("garbage"), []);
  // Agrees with the week id the coach stores records under.
  for (const d of t.weekDates(WEEK)) assert.strictEqual(coach.isoWeek(new Date(d + "T12:00:00Z")), WEEK);
});

test("normalizeChecks keeps well-formed checks only, capped at four", () => {
  const out = t.normalizeChecks([
    { kind: "sessions", min: 4 }, { kind: "sessions", min: "4" }, { kind: "bogus", min: 1 },
    { kind: "session", name: " Upper B " }, { kind: "session" },
    { kind: "muscle_sets", muscle: "Chest", min: 10 }, { kind: "rest_days", min: 1 }, { kind: "kcal", min: 2800 },
  ]);
  assert.deepStrictEqual(out, [
    { kind: "sessions", min: 4 }, { kind: "session", name: "Upper B" },
    { kind: "muscle_sets", muscle: "chest", min: 10 }, { kind: "rest_days", min: 1 },
  ]);
  assert.deepStrictEqual(t.normalizeChecks("nope"), []);
});

const day = (date, rested) => ({ date, dow: "x", lifted: rested ? [] : ["s"], runs: [], rested });
const snap = () => ({
  errors: [],
  history: [
    { week: "2026-W44", sessions: 4, muscleSets: { chest: 13, quadriceps: 12 } },
    { week: WEEK, sessions: 3, muscleSets: { chest: 9 } },
  ],
  strength: [
    { date: "2026-11-10", title: "Lower A" }, { date: "2026-11-07", title: "Lower B" },
    { date: "2026-11-03", title: "Lower A" }, { date: "2026-11-02", title: "Upper A" },
    { date: "2026-10-30", title: "Upper B" },
  ],
  rest: { sources_complete: true, days: [
    day("2026-11-10", false), day("2026-11-09", false), day("2026-11-08", false), day("2026-11-07", false),
    day("2026-11-06", true), day("2026-11-05", false), day("2026-11-04", true), day("2026-11-03", false),
    day("2026-11-02", false), day("2026-11-01", false),
  ] },
  nutrition: { days: ["02", "03", "04", "05", "06", "07"].map((d) => ({ date: `2026-11-${d}`, kcal: 2600, protein_g: 160, weight_kg: 80 })) },
});
const grade = (c, s = snap()) => t.gradeCheck(c, WEEK, s);

test("sessions and named-session checks", () => {
  assert.strictEqual(grade({ kind: "sessions", min: 3 }).status, "hit");
  assert.deepStrictEqual(grade({ kind: "sessions", min: 4 }), { kind: "sessions", min: 4, actual: 3, status: "partial" });
  assert.strictEqual(grade({ kind: "sessions", min: 6 }).status, "missed");
  assert.strictEqual(grade({ kind: "session", name: "Lower B" }).status, "hit");
  assert.strictEqual(grade({ kind: "session", name: "Upper B" }).status, "missed", "done the week before, not this one");
});

test("muscle_sets: counted, zero when skipped, unknown when the name is not a muscle group", () => {
  assert.strictEqual(grade({ kind: "muscle_sets", muscle: "chest", min: 10 }).actual, 9);
  assert.strictEqual(grade({ kind: "muscle_sets", muscle: "chest", min: 10 }).status, "partial");
  assert.deepStrictEqual(grade({ kind: "muscle_sets", muscle: "quadriceps", min: 10 }),
    { kind: "muscle_sets", muscle: "quadriceps", min: 10, actual: 0, status: "missed" });
  assert.strictEqual(grade({ kind: "muscle_sets", muscle: "quads", min: 10 }).status, "unknown");
});

test("rest_days and intake checks", () => {
  assert.strictEqual(grade({ kind: "rest_days", min: 1 }).actual, 2);
  assert.strictEqual(grade({ kind: "rest_days", min: 1 }).status, "hit");
  assert.strictEqual(grade({ kind: "kcal", min: 2500 }).status, "hit");
  assert.strictEqual(grade({ kind: "kcal", min: 2800 }).status, "partial");
  assert.strictEqual(grade({ kind: "kcal", min: 3200 }).status, "missed");
  assert.strictEqual(grade({ kind: "protein_gkg", min: 1.6 }).actual, 2);
});

test("a failed source or thin logging grades as unknown, never as a miss", () => {
  const down = { ...snap(), errors: ["hevy: 500"] };
  assert.strictEqual(grade({ kind: "sessions", min: 4 }, down).status, "unknown");
  assert.strictEqual(grade({ kind: "session", name: "Upper B" }, down).status, "unknown");
  const blind = { ...snap(), rest: { sources_complete: false, days: snap().rest.days } };
  assert.strictEqual(grade({ kind: "rest_days", min: 1 }, blind).status, "unknown");
  const thin = { ...snap(), nutrition: { days: snap().nutrition.days.slice(0, 3) } };
  assert.strictEqual(grade({ kind: "kcal", min: 2800 }, thin).status, "unknown");
  assert.strictEqual(grade({ kind: "kcal", min: 2800 }, { ...snap(), nutrition: null }).status, "unknown");
  // Session list too short to see the whole week.
  const short = { ...snap(), strength: snap().strength.slice(0, 2) };
  assert.strictEqual(grade({ kind: "session", name: "Upper A" }, short).status, "unknown");
});

test("gradeLedger grades only last week's record and leaves check-less records alone", () => {
  const ledger = [
    { week: "2026-W44", priority: "old", checks: [{ kind: "sessions", min: 4 }] },
    { week: WEEK, priority: "chest", checks: [{ kind: "sessions", min: 4 }, { kind: "nonsense" }] },
  ];
  const out = t.gradeLedger(ledger, WEEK, snap());
  assert.strictEqual(out[0].grades, undefined);
  assert.strictEqual(out[1].grades.length, 1);
  assert.strictEqual(out[1].grades[0].status, "partial");
  const plain = [{ week: WEEK, priority: "p" }];
  assert.deepStrictEqual(t.gradeLedger(plain, WEEK, snap()), plain);
  assert.deepStrictEqual(t.gradeLedger(null, WEEK, snap()), []);
});

test("splitTargets strips the trailer from the message whether or not it parses", () => {
  const good = coach.splitTargets('Readout\n<<<TARGETS {"priority":"p","fix":"f","fuel":null,"checks":[{"kind":"rest_days","min":1}]} >>>', WEEK);
  assert.strictEqual(good.message, "Readout");
  assert.deepStrictEqual(good.targets, { week: WEEK, priority: "p", fix: "f", fuel: null, checks: [{ kind: "rest_days", min: 1 }] });
  const bad = coach.splitTargets("Readout\n<<<TARGETS {not json", WEEK);
  assert.strictEqual(bad.message, "Readout");
  assert.strictEqual(bad.targets, null);
  assert.strictEqual(coach.splitTargets("Readout", WEEK).targets, null);
});
