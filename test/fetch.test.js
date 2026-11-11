const test = require("node:test");
const assert = require("node:assert");
const f = require("../fetch");

test("isoWeek handles year boundaries", () => {
  assert.strictEqual(f.isoWeek(new Date("2026-11-11T12:00:00Z")), "2026-W46");
  assert.strictEqual(f.isoWeek(new Date("2027-01-03T12:00:00Z")), "2026-W53"); // Sunday
  assert.strictEqual(f.isoWeek(new Date("2027-01-04T12:00:00Z")), "2027-W01"); // Monday
  assert.strictEqual(f.isoWeek(new Date("2024-12-30T12:00:00Z")), "2025-W01");
});

test("stockholmDay puts a workout logged just after local midnight on the right day", () => {
  assert.strictEqual(f.stockholmDay("2026-11-10T23:30:00Z"), "2026-11-11"); // 00:30 CET
  assert.strictEqual(f.stockholmDay("2026-07-10T21:59:00Z"), "2026-07-10"); // 23:59 CEST
  assert.strictEqual(f.stockholmDay("2026-07-10T22:01:00Z"), "2026-07-11");
});

test("dowOf and dayMinus", () => {
  assert.strictEqual(f.dowOf("2026-11-11"), "Wed");
  assert.strictEqual(f.dayMinus("2026-11-01", 1), "2026-10-31");
  assert.strictEqual(f.dayMinus("2026-03-30", 2), "2026-03-28"); // across the DST change
});

test("isRunMirror catches mirrored runs by template or by title, and nothing else", () => {
  assert.ok(f.isRunMirror({ title: "Whatever", exercises: [{ exercise_template_id: "AC1BB830" }] }));
  assert.ok(f.isRunMirror({ title: "Running (intervals)", exercises: [] }));
  assert.ok(!f.isRunMirror({ title: "Lower A", exercises: [{ exercise_template_id: "X" }, { exercise_template_id: "AC1BB830" }] }));
  assert.ok(!f.isRunMirror({ title: "Upper A", exercises: [] }));
  assert.ok(!f.isRunMirror(null));
});

test("regressionTrendPct: steady climb is positive, one bad day does not flip it, old sessions are ignored", () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const pts = (vals, step = 5) => vals.map((v, i) => ({ date: day((vals.length - i) * step), bestE1rm: v }));
  assert.ok(f.regressionTrendPct(pts([100, 102, 104, 106, 108])) > 5);
  assert.ok(f.regressionTrendPct(pts([100, 102, 104, 106, 108, 99])) > 0, "one bad last day");
  assert.strictEqual(f.regressionTrendPct(pts([100])), 0);
  // Everything older than 60 days falls outside the current block.
  assert.strictEqual(f.regressionTrendPct([{ date: day(200), bestE1rm: 50 }, { date: day(190), bestE1rm: 90 }]), 0);
});

// Wed 2026-11-11 is "today" throughout.
const TODAY = "2026-11-11";
const lift = (date, title) => ({ date, title });

test("restDays excludes today and needs BOTH sources quiet for a rest day", () => {
  const strength = [lift("2026-11-10", "Lower A"), lift("2026-11-09", "Upper A"), lift("2026-11-07", "Lower B"), lift("2026-11-06", "Upper B")];
  const runs = [{ day: "2026-11-08", duration_min: 60 }, { day: "2026-11-05", duration_min: 30 }];
  const r = f.restDays(strength, runs, true, TODAY);
  assert.strictEqual(r.days[0].date, "2026-11-10", "yesterday first, today absent");
  assert.ok(!r.days.some((d) => d.date === TODAY));
  // Trained 5-10 Nov (six days), rested Wed 4 Nov.
  assert.strictEqual(r.consecutive_training_days, 6);
  assert.strictEqual(r.rest_days, 1);
  assert.deepStrictEqual(r.rest_dates, [{ date: "2026-11-04", dow: "Wed" }]);
  assert.strictEqual(r.meets_target, true);
  // The run-only Sunday is a training day, not rest.
  assert.strictEqual(r.days.find((d) => d.date === "2026-11-08").rested, false);
});

test("restDays flags a week with no rest, and withholds the verdict when a source failed", () => {
  const strength = ["10", "09", "07", "06", "04"].map((d) => lift(`2026-11-${d}`, "x"));
  const runs = [{ day: "2026-11-08" }, { day: "2026-11-05" }];
  const r = f.restDays(strength, runs, true, TODAY);
  assert.strictEqual(r.rest_days, 0);
  assert.strictEqual(r.meets_target, false);
  const blind = f.restDays(strength, [], false, TODAY);
  assert.strictEqual(blind.meets_target, null, "missing runs must not read as rest");
  assert.ok(blind.note);
});

test("cycleStatus reads the weekday plan from program.json and ranks the most overdue session", () => {
  const strength = [lift("2026-11-10", "Lower A"), lift("2026-11-09", "Upper A"), lift("2026-11-07", "Lower B"), lift("2026-10-30", "Upper B")];
  const c = f.cycleStatus(strength, TODAY);
  assert.strictEqual(c.today_is, "Wednesday");
  assert.strictEqual(c.scheduled_today, "Rest");
  assert.strictEqual(c.scheduled_tomorrow, "Run (hard intervals)");
  assert.strictEqual(c.most_overdue, "Upper B");
  assert.strictEqual(c.days_since_session["Upper B"], 12);
  assert.strictEqual(c.days_since_session["Lower A"], 1);
  // A session never seen in the lookback outranks everything.
  assert.strictEqual(f.cycleStatus(strength.slice(0, 3), TODAY).most_overdue, "Upper B");
  assert.strictEqual(f.cycleStatus(strength.slice(0, 3), TODAY).days_since_session["Upper B"], null);
});
