const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("mirror posts each existing file once and skips missing ones, never throwing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-"));
  const cwd = process.cwd();
  process.chdir(dir);
  fs.writeFileSync("fitness.json.enc", "CIPHERTEXT\n");
  process.env.INGEST_TOKEN = "t";
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: calls.length === 1, status: 500, statusText: "x" }; };
  try {
    delete require.cache[require.resolve("../mirror")];
    const { mirror } = require("../mirror");
    fs.writeFileSync("history.json.enc", "H");
    const ok = await mirror(["fitness.json.enc", "history.json.enc", "absent.json.enc"]);
    assert.equal(ok, 1);
    assert.deepEqual(calls, [{ name: "fitness.json.enc", data: "CIPHERTEXT" }, { name: "history.json.enc", data: "H" }]);
  } finally {
    global.fetch = realFetch;
    delete process.env.INGEST_TOKEN;
    process.chdir(cwd);
  }
});
