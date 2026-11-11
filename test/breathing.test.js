const test = require("node:test");
const assert = require("node:assert");
const lib = require("../breathing-lib");

// 12 minutes at 5 s spacing, resting 75 bpm, with dips to `low` centred on the
// given minutes: the shape a retention round leaves in the HR curve.
function curve(dipsAtMin, low = 55, n = 144) {
  const out = new Array(n).fill(75);
  for (const m of dipsAtMin) {
    const c = Math.round((m * 60) / 5);
    for (let i = -6; i <= 6; i++) if (out[c + i] !== undefined) out[c + i] = low + Math.abs(i) * ((75 - low) / 6);
  }
  return out;
}

test("detectHolds finds exactly the dips that are there", () => {
  const d = lib.detectHolds(curve([3, 6, 9]), 5);
  assert.strictEqual(d.quality, "good");
  assert.strictEqual(d.holds.length, 3);
  assert.deepStrictEqual(d.holds.map((h) => Math.round(h.min)), [3, 6, 9]);
  assert.strictEqual(lib.detectHolds(curve([4, 8]), 5).holds.length, 2, "no assumed round count");
});

test("detectHolds calls a flat or empty session inconclusive instead of inventing rounds", () => {
  assert.strictEqual(lib.detectHolds(curve([]), 5).quality, "inconclusive");
  assert.strictEqual(lib.detectHolds(curve([]), 5).holds.length, 0);
  assert.strictEqual(lib.detectHolds([], 5).quality, "inconclusive");
  // Shallow 3 bpm wobble is drift, not a hold.
  assert.strictEqual(lib.detectHolds(curve([3, 6, 9], 72), 5).holds.length, 0);
});

test("detectHolds downgrades quality when the sensor dropped out", () => {
  const gappy = curve([3, 6, 9]).map((v, i) => (i % 3 === 0 ? v : null)); // ~33% coverage
  assert.strictEqual(lib.detectHolds(gappy, 5).quality, "inconclusive");
});

test("resonanceMetrics: settle minute, HRV lift", () => {
  const m = lib.resonanceMetrics({ hr: { minutes: [70, 69, 66, 64, 63, 63] }, hrv: { minutes: [40, 42, 50, 55, 60, 62] } });
  assert.strictEqual(m.settle_min, 2);
  assert.strictEqual(m.hrv_lift, 20);
  assert.strictEqual(m.hr_min, 63);
});

test("session template never states a round count the curve does not show", () => {
  const msg = lib.templateSession({
    practice: "wim_hof", duration_min: 12, start_local: "09:10", day: "2026-11-11", time_of_day: "morning",
    holds: [], holds_quality: "inconclusive", holds_note: "no clear breath-hold dips visible in the HR curve",
    hrv: { avg: null, max: null }, streak_days: 1, sessions_today: 1,
  });
  assert.match(msg, /inconclusive/);
  assert.doesNotMatch(msg, /\d+ holds?/);
});
