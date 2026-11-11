// Grades last week's coach targets IN CODE.
//
// The coach used to write its targets as free text and grade them itself the
// following Monday, which made the grade as reliable as the model's reading of
// a 50 KB payload. Now each target may carry `checks`: a short list from a closed
// vocabulary that this file can verify against the snapshot. The model still
// chooses the targets and writes the sentence; it no longer decides whether
// they were met.
//
//   { kind: "sessions",     min: 4 }                    lifting sessions that week
//   { kind: "session",      name: "Upper B" }           that session was performed
//   { kind: "muscle_sets",  muscle: "chest", min: 10 }  sets for a Hevy muscle group
//   { kind: "rest_days",    min: 1 }                    full rest days (no lift, no run)
//   { kind: "kcal",         min: 2800 }                 average logged intake
//   { kind: "protein_gkg",  min: 1.6 }                  average protein per kg bodyweight
//
// Every grade is hit / partial / missed / unknown with the actual figure
// attached. "unknown" is a real answer: a failed source or a thinly logged week
// must not be reported as a miss.

const KINDS = ["sessions", "session", "muscle_sets", "rest_days", "kcal", "protein_gkg"];
const MAX_CHECKS = 4;
const MIN_LOGGED_DAYS = 5; // of 7, before an intake average means anything

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Keeps only well-formed checks, so a malformed trailer costs that one check
// rather than the whole record.
function normalizeChecks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || !KINDS.includes(c.kind)) continue;
    if (c.kind === "session") {
      if (typeof c.name === "string" && c.name.trim()) out.push({ kind: c.kind, name: c.name.trim() });
    } else if (c.kind === "muscle_sets") {
      if (typeof c.muscle === "string" && c.muscle.trim() && num(c.min) != null) {
        out.push({ kind: c.kind, muscle: c.muscle.trim().toLowerCase(), min: c.min });
      }
    } else if (num(c.min) != null) {
      out.push({ kind: c.kind, min: c.min });
    }
    if (out.length === MAX_CHECKS) break;
  }
  return out;
}

// The seven dates (Mon..Sun) of an ISO week id like "2026-W45". Jan 4 is always
// in week 1, which is the standard way to anchor the calculation.
function weekDates(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(week || ""));
  if (!m) return [];
  const jan4 = new Date(Date.UTC(+m[1], 0, 4));
  const monday = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000 + (+m[2] - 1) * 7 * 86400000;
  return Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86400000).toISOString().slice(0, 10));
}

function verdict(actual, min) {
  if (actual >= min) return "hit";
  return min > 0 && actual >= 0.75 * min ? "partial" : "missed";
}

function gradeCheck(c, week, snap) {
  const dates = new Set(weekDates(week));
  const hevyFailed = (snap.errors || []).some((e) => String(e).startsWith("hevy"));
  const entry = (snap.history || []).find((h) => h.week === week) || null;
  const unknown = (why) => ({ ...c, status: "unknown", why });

  if (c.kind === "sessions") {
    if (hevyFailed || !entry || num(entry.sessions) == null) return unknown("no lifting history for that week");
    return { ...c, actual: entry.sessions, status: verdict(entry.sessions, c.min) };
  }

  if (c.kind === "session") {
    if (hevyFailed || !Array.isArray(snap.strength) || !snap.strength.length) return unknown("no session list available");
    // The list holds only the most recent ~20 sessions. If its oldest entry is
    // newer than the week's Monday, part of the week has scrolled out of view.
    const oldest = snap.strength.map((s) => s.date).filter(Boolean).sort()[0];
    const monday = [...dates].sort()[0];
    const done = snap.strength.some((s) => s.date && dates.has(s.date) &&
      String(s.title || "").toLowerCase().includes(c.name.toLowerCase()));
    if (!done && oldest && oldest > monday) return unknown("session list does not reach back over the whole week");
    return { ...c, actual: done, status: done ? "hit" : "missed" };
  }

  if (c.kind === "muscle_sets") {
    if (hevyFailed || !entry || !entry.muscleSets) return unknown("no per-muscle set counts for that week");
    const find = (o) => Object.keys(o || {}).find((k) => k.toLowerCase() === c.muscle);
    const key = find(entry.muscleSets);
    if (!key) {
      // Absent that week. If the name appears in no week at all it is probably
      // not a Hevy muscle group, and zero would be a confident wrong answer.
      const known = (snap.history || []).some((h) => find(h.muscleSets));
      if (!known) return unknown(`"${c.muscle}" is not a muscle group in the log`);
      return { ...c, actual: 0, status: verdict(0, c.min) };
    }
    return { ...c, actual: entry.muscleSets[key], status: verdict(entry.muscleSets[key], c.min) };
  }

  if (c.kind === "rest_days") {
    const rest = snap.rest;
    if (!rest || !rest.sources_complete || !Array.isArray(rest.days)) return unknown("rest log incomplete (a source failed)");
    const rows = rest.days.filter((d) => dates.has(d.date));
    if (rows.length < 7) return unknown("rest log does not cover the whole week");
    const n = rows.filter((d) => d.rested).length;
    return { ...c, actual: n, status: n >= c.min ? "hit" : "missed" };
  }

  // kcal and protein_gkg, both from the logged food days of that week.
  const days = ((snap.nutrition && snap.nutrition.days) || []).filter((d) => dates.has(d.date));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  if (c.kind === "kcal") {
    const k = days.map((d) => num(d.kcal)).filter((v) => v != null && v > 0);
    if (k.length < MIN_LOGGED_DAYS) return unknown(`only ${k.length} of 7 days logged`);
    const a = Math.round(avg(k));
    return { ...c, actual: a, logged_days: k.length, status: verdict(a, c.min) === "hit" ? "hit" : a >= 0.9 * c.min ? "partial" : "missed" };
  }
  if (c.kind === "protein_gkg") {
    const p = days.map((d) => num(d.protein_g)).filter((v) => v != null && v > 0);
    if (p.length < MIN_LOGGED_DAYS) return unknown(`only ${p.length} of 7 days logged`);
    const all = (snap.nutrition && snap.nutrition.days) || [];
    const w = [...all].sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((d) => num(d.weight_kg)).find((v) => v != null && v > 0);
    if (!w) return unknown("no bodyweight alongside the food log");
    const a = Math.round((avg(p) / w) * 100) / 100;
    return { ...c, actual: a, logged_days: p.length, status: a >= c.min ? "hit" : a >= 0.9 * c.min ? "partial" : "missed" };
  }
  return unknown("unrecognised check");
}

// Returns the ledger with `grades` attached to the record for `week` (the week
// just completed). Records without checks pass through untouched and are graded
// in prose by the coach, as before.
function gradeLedger(ledger, week, snap) {
  return (ledger || []).map((rec) => {
    if (!rec || rec.week !== week) return rec;
    const checks = normalizeChecks(rec.checks);
    if (!checks.length) return rec;
    return { ...rec, grades: checks.map((c) => gradeCheck(c, week, snap)) };
  });
}

module.exports = { KINDS, normalizeChecks, weekDates, gradeCheck, gradeLedger };
