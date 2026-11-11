// Mirror the encrypted snapshots to the breathing-bot Worker.
//
// First step of taking the health data out of this public repo: the Worker
// stores the same ciphertext the workflows commit, and readers can move to
// GET /export/snapshot. Once every reader has, the commit steps come out
// (docs/worker-contract.md, step 5). The Worker holds no key and never sees
// plaintext.
//
// Usage: node mirror.js fitness.json.enc history.json.enc
// Never fatal: git stays the source of truth until the switch, so a Worker
// hiccup costs the mirror one run and nothing else.

const fs = require("fs");

const URL_ = process.env.SNAPSHOT_INGEST_URL ||
  "https://breathing-bot.w-kugelberg.workers.dev/ingest/snapshot";
const TOKEN = process.env.INGEST_TOKEN;

async function mirror(names) {
  if (!TOKEN) { console.log("mirror: no INGEST_TOKEN, skipping"); return 0; }
  let ok = 0;
  for (const name of names) {
    if (!fs.existsSync(name)) { console.log(`mirror: ${name} missing, skipped`); continue; }
    try {
      const res = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name, data: fs.readFileSync(name, "utf8").trim() }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      ok++;
      console.log(`mirror: ${name} stored`);
    } catch (e) {
      console.error(`mirror: ${name} failed: ${e.message}`);
    }
  }
  return ok;
}

if (require.main === module) {
  mirror(process.argv.slice(2)).catch((e) => console.error(`mirror: ${e.message}`));
}

module.exports = { mirror };
