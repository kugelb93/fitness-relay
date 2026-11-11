const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("../crypto-lib");

const key = lib.keyFromPassphrase("correct horse battery staple");
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-")), "x.enc");

test("reads a v1 file produced by the original scheme, byte for byte", () => {
  // Built with raw crypto, independent of the lib, exactly as the pre-lib
  // fetch.js did: this is the format every committed snapshot is in today.
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv("aes-256-cbc", crypto.createHash("sha256").update("correct horse battery staple").digest(), iv);
  const blob = Buffer.concat([iv, c.update('{"a":1}', "utf8"), c.final()]).toString("base64") + "\n";
  assert.deepStrictEqual(JSON.parse(lib.decryptString(blob, key)), { a: 1 });
});

test("v1 and v2 both round-trip", () => {
  for (const f of ["v1", "v2"]) {
    const enc = lib.encryptString('{"hello":"värld"}', key, f);
    assert.strictEqual(enc.startsWith("v2:"), f === "v2");
    assert.strictEqual(lib.decryptString(enc, key), '{"hello":"värld"}');
  }
});

test("v2 rejects tampering and the wrong passphrase", () => {
  const enc = lib.encryptString("secret", key, "v2");
  const raw = Buffer.from(enc.slice(3), "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => lib.decryptString("v2:" + raw.toString("base64"), key));
  assert.throws(() => lib.decryptString(enc, lib.keyFromPassphrase("nope")));
});

test("write format follows ENC_FORMAT and defaults to v1", () => {
  const prev = process.env.ENC_FORMAT;
  try {
    delete process.env.ENC_FORMAT;
    assert.strictEqual(lib.writeFormat(), "v1");
    process.env.ENC_FORMAT = "v2";
    assert.strictEqual(lib.writeFormat(), "v2");
  } finally {
    if (prev === undefined) delete process.env.ENC_FORMAT; else process.env.ENC_FORMAT = prev;
  }
});

test("encryptToFileIfChanged skips a no-op, ignores generated_at, and migrates format", () => {
  const prev = process.env.ENC_FORMAT;
  const p = tmp();
  try {
    delete process.env.ENC_FORMAT;
    assert.strictEqual(lib.encryptToFileIfChanged(p, { generated_at: "t1", n: 1 }, key), true);
    assert.strictEqual(lib.encryptToFileIfChanged(p, { generated_at: "t2", n: 1 }, key), false);
    assert.strictEqual(lib.encryptToFileIfChanged(p, { generated_at: "t3", n: 2 }, key), true);
    process.env.ENC_FORMAT = "v2";
    assert.strictEqual(lib.encryptToFileIfChanged(p, { generated_at: "t4", n: 2 }, key), true, "same data, new format");
    assert.ok(fs.readFileSync(p, "utf8").startsWith("v2:"));
    assert.deepStrictEqual(lib.decryptFile(p, key), { generated_at: "t4", n: 2 });
    assert.strictEqual(lib.encryptToFileIfChanged(p, { generated_at: "t5", n: 2 }, key), false);
  } finally {
    if (prev === undefined) delete process.env.ENC_FORMAT; else process.env.ENC_FORMAT = prev;
  }
});
