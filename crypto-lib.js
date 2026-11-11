// The one copy of the snapshot crypto. fetch.js, meditation.js and
// breathing-lib.js each used to carry their own, which is how three files ended
// up needing the same fix three times.
//
// Two on-disk formats, both read transparently:
//
//   v1  base64(iv[16] || AES-256-CBC(sha256(passphrase), plaintext))
//       The original. No integrity check, and the key is one unsalted hash, so
//       a guessable passphrase falls to an offline dictionary run against any
//       snapshot in the public history.
//
//   v2  "v2:" + base64(salt[16] || iv[12] || tag[16] || AES-256-GCM(key, plaintext))
//       key = scrypt(passphrase, salt, N=2^15, r=8, p=1). Authenticated, so a
//       tampered or truncated file fails loudly instead of decrypting to
//       garbage, and each guess costs a memory-hard derivation.
//
// WRITES stay v1 unless ENC_FORMAT=v2. That is deliberate: the daily brief
// routine decrypts fitness.json.enc on its own, outside this repo, and it has to
// learn v2 (snippet in the README) BEFORE the switch is flipped, or it goes blind.

const fs = require("fs");
const crypto = require("crypto");

const V2_PREFIX = "v2:";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Returns an opaque handle rather than a raw key: v2 derives a fresh key per
// file from the passphrase and that file's salt, so the passphrase has to travel.
function keyFromPassphrase(pass) {
  return { pass: String(pass), v1: crypto.createHash("sha256").update(pass).digest() };
}

function writeFormat() {
  return process.env.ENC_FORMAT === "v2" ? "v2" : "v1";
}

function encryptString(plain, key, format = writeFormat()) {
  if (format === "v2") {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const k = crypto.scryptSync(key.pass, salt, 32, SCRYPT);
    const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return V2_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key.v1, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

function decryptString(text, key) {
  const t = String(text).trim();
  if (t.startsWith(V2_PREFIX)) {
    const buf = Buffer.from(t.slice(V2_PREFIX.length), "base64");
    if (buf.length < 44) throw new Error("v2 ciphertext too short");
    const k = crypto.scryptSync(key.pass, buf.subarray(0, 16), 32, SCRYPT);
    const dec = crypto.createDecipheriv("aes-256-gcm", k, buf.subarray(16, 28));
    dec.setAuthTag(buf.subarray(28, 44));
    return Buffer.concat([dec.update(buf.subarray(44)), dec.final()]).toString("utf8");
  }
  const buf = Buffer.from(t, "base64");
  const dec = crypto.createDecipheriv("aes-256-cbc", key.v1, buf.subarray(0, 16));
  return Buffer.concat([dec.update(buf.subarray(16)), dec.final()]).toString("utf8");
}

function encryptToFile(path, obj, key) {
  fs.writeFileSync(path, encryptString(JSON.stringify(obj), key) + "\n");
}

function decryptFile(path, key) {
  return JSON.parse(decryptString(fs.readFileSync(path, "utf8"), key));
}

// Every write takes fresh randomness, so re-encrypting identical data still
// lands a different file, and generated_at moves every run regardless. Compare
// the decrypted payload minus the moving stamp and skip a no-op write, otherwise
// a poller commits on every run. A file still in the other format counts as
// changed, so flipping ENC_FORMAT migrates it on the next run.
function encryptToFileIfChanged(path, obj, key) {
  const stable = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return JSON.stringify(o);
    const { generated_at, ...rest } = o;
    return JSON.stringify(rest);
  };
  if (fs.existsSync(path)) {
    try {
      const onDisk = fs.readFileSync(path, "utf8").trim();
      const sameFormat = onDisk.startsWith(V2_PREFIX) === (writeFormat() === "v2");
      if (sameFormat && stable(JSON.parse(decryptString(onDisk, key))) === stable(obj)) return false;
    } catch {
      // Unreadable, truncated, or written under a different key: rewrite it.
    }
  }
  encryptToFile(path, obj, key);
  return true;
}

module.exports = {
  keyFromPassphrase, encryptString, decryptString,
  encryptToFile, decryptFile, encryptToFileIfChanged, writeFormat,
};
