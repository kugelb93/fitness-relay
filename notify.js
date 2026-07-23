#!/usr/bin/env node
// Per-session breathing notifier, run in GitHub Actions right after
// meditation.js. Detects sessions not yet notified, composes a summary
// (Claude if ANTHROPIC_API_KEY is set, else a built-in template), and posts it
// to Slack. Dedupe is a committed encrypted set of already-notified session
// ids, so it is independent of timing and never double-sends.
//
// First run bootstraps: it seeds the notified set with every current session
// and sends nothing, so existing history is never blasted out.
//
// Env: FITNESS_KEY (required). SLACK_BOT_TOKEN, ANTHROPIC_API_KEY optional
// (missing -> no send / template). DRY_RUN=1 prints instead of sending.

const fs = require("fs");
const lib = require("./breathing-lib");

const NOTIFIED = "notified.json.enc";
const MED = "meditation.json.enc";

async function main() {
  const pass = process.env.FITNESS_KEY;
  if (!pass) { console.error("FITNESS_KEY not set"); process.exit(1); }
  const key = lib.keyFromPassphrase(pass);

  if (!fs.existsSync(MED)) { console.log("no meditation snapshot yet"); return; }
  const snap = lib.decryptFile(MED, key);
  const sessions = (snap.sessions || []).filter((s) => s.id && s.start);

  let notified = null;
  if (fs.existsSync(NOTIFIED)) {
    try { notified = new Set(lib.decryptFile(NOTIFIED, key)); }
    catch (e) { console.error("notified set unreadable, re-bootstrapping:", e.message); notified = null; }
  }

  // Bootstrap: seed with all current ids, send nothing.
  if (notified === null) {
    lib.encryptToFile(NOTIFIED, sessions.map((s) => s.id), key);
    console.log(`bootstrapped notified set with ${sessions.length} sessions (no sends)`);
    return;
  }

  // Test hook: re-send the most recent session once (workflow_dispatch).
  if (process.env.RESEND_LATEST === "1" && sessions.length) {
    notified.delete(sessions[sessions.length - 1].id);
    console.log("RESEND_LATEST: latest session cleared from notified set");
  }

  const fresh = sessions.filter((s) => !notified.has(s.id));
  if (!fresh.length) { console.log("no new sessions"); return; }

  const today = new Date().toISOString().slice(0, 10);
  let sent = 0;
  for (const s of fresh) {
    try {
      const a = lib.analyzeSession(s, snap.stats);
      a.not_today = s.day !== today;
      const msg = await lib.compose("session", a);
      const ok = await lib.postSlack(msg);
      if (ok || process.env.DRY_RUN === "1") { notified.add(s.id); sent++; }
    } catch (e) {
      console.error(`failed on session ${s.id.slice(0, 8)}:`, e.message);
    }
  }
  lib.encryptToFile(NOTIFIED, [...notified], key);
  console.log(`notified ${sent} of ${fresh.length} new session(s)`);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
