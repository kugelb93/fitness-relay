# fitness-brief

Relay that feeds the daily Slack brief a workout suggestion.

The brief runs as a cloud routine in a sandbox whose network proxy blocks
`api.hevyapp.com` and `api.ouraring.com`. GitHub *is* reachable from that
sandbox, so this repo bridges the gap:

1. A GitHub Actions workflow (`.github/workflows/fetch.yml`) calls Hevy + Oura
   and commits an **encrypted** `fitness.json.enc`. It is meant to be started by
   a `repository_dispatch` from the breathing-bot Worker; the cron in the file is
   only a fallback (see "Scheduling" below for why).
2. The brief routine reads `fitness.json.enc` from the public raw URL, decrypts
   it with a shared passphrase, and turns it into the "Training" section.

This repo is public, so nothing readable is ever written: the payload is
encrypted (see "Crypto") and the workflows log counts only, never values.

## Layout

| File | What it does |
|---|---|
| `fetch.js` | Hevy + Oura + nutrition -> `fitness.json.enc`, `history.json.enc` |
| `coach.js` | Monday readout, written by Claude, DM'd as the bot |
| `daily.js` | Morning line (today's session, overdue, recovery, rest), no model |
| `targets.js` | Grades last week's coach targets in code |
| `program.json` / `program.js` | The training programme, the single source for it |
| `meditation.js`, `notify.js`, `digest.js`, `breathing-lib.js` | Breathing sessions |
| `crypto-lib.js` | The one copy of the snapshot crypto |
| `test/` | `npm test` (Node's built-in runner, no dependencies) |

## Scheduling

GitHub starts scheduled workflows when it has capacity, not at the stated time.
Measured from this repo's own run log, Oct-Nov 2026:

| Workflow | Cron says (UTC) | Actually started (UTC) |
|---|---|---|
| fetch-fitness | 05:00 | 09:00 to 13:30, never before the 07:30 brief |
| weekly-coach | Mon 05:15 | 10:44 to 13:52 |
| fetch-meditation | every 5 min | every 4 to 8 hours |

So every time-sensitive workflow takes a `repository_dispatch`, which starts
within seconds, and the Worker (whose cron triggers are punctual and can follow
Stockholm time across DST) is what should fire them:

| `event_type` | Workflow | When the Worker should send it |
|---|---|---|
| `fetch_fitness` | fetch-fitness | 06:45 and 09:00 Stockholm, daily |
| `daily_line` | daily-line | 07:00 Stockholm, daily |
| `weekly_coach` | weekly-coach | Monday 07:15 Stockholm |
| `oura_new_data` | fetch-meditation | on the Oura session webhook |

`POST https://api.github.com/repos/kugelb93/fitness-relay/dispatches` with body
`{"event_type":"..."}` and a fine-grained token that has **Contents: read and
write** on this repo only. The crons stay as fallbacks: `coach.js` skips a late
cron run when the week's readout was already sent, and `daily-line` has no cron
at all because a morning line that lands after lunch is noise (it also refuses
to send after 11:00 local unless forced). `docs/worker-contract.md` lists
everything the Worker side still has to do.

## The programme lives in program.json

The weekday plan, the four sessions with their set counts, and the designed
weekly sets per muscle are data in `program.json`. `fetch.js` reads the plan and
cycle from it and `coach.js` renders the prompt's programme text from it, so a
change to the split is one edit. `temporary_rules` holds coaching rules that are
only true for a while; each has an `expires` date (last day it applies) and
stops being sent to the model after it:

```json
"temporary_rules": [
  { "text": "Travelling 16-20 Nov, hotel gym only: do not flag missed barbell work.", "expires": "2026-11-22" }
]
```

## Targets are graded in code

Each Monday the coach stores what it told him (priority, fix, fuel) in the
Worker's targets ledger, now with `checks`: up to four machine-verifiable
conditions from a closed list (`sessions`, `session`, `muscle_sets`,
`rest_days`, `kcal`, `protein_gkg`; shapes in `targets.js`). The following
Monday `targets.js` verifies each against the snapshot and hands the model a
`grades` array (hit / partial / missed / unknown, with the actual figure). The
model reports the grade; it no longer decides it. A failed source or a thinly
logged week grades as `unknown`, never as a miss. Records without checks are
still graded in prose, as before.

## Morning line

`daily.js` sends one short DM: today's scheduled session, an overdue session if
one is 8+ days stale, readiness and sleep against his own p25-p75 range (only
when the ring has synced today's row), and a rest-day warning when one is owed.
It is assembled from fields `fetch.js` already computes, with no model call.

## Secrets (repo settings > Secrets and variables > Actions)

- `HEVY_API_KEY` - Hevy Pro API key
- `OURA_TOKEN` - Oura v2 Personal Access Token
- `FITNESS_KEY` - shared passphrase; key = sha256(passphrase). The routine holds
  the same value.
- `INGEST_TOKEN` - OPTIONAL. Bearer token for reading Apple Health nutrition back
  from the breathing-bot Worker (`/export/nutrition`). Same value as that
  Worker's `INGEST_TOKEN` secret. Leave it unset and the snapshot simply carries
  no nutrition; the coach then omits its FUEL line instead of failing.

## Lifting sessions exclude mirrored runs

Since 2026-08-20 breathing-bot writes every Oura-detected run into Hevy as a
workout (one "Running" exercise, template `AC1BB830`, titled `Running
(intervals)` / `Running (same speed)`) so his Hevy calendar shows run days as
well as lifting days. Those rows are not lifting sessions, so `fetch.js` drops
them (`isRunMirror`) before anything counts sessions: `strength`, the rest-day
log, `sessionsLast7/28`, `perWeek` and the weekly session history. Runs continue
to reach the coach from Oura, unchanged. Remove that filter and a two-run week
reads as six lifting sessions.

## Decrypted payload shape

```json
{
  "generated_at": "ISO-8601 UTC",
  "strength": [{ "date": "YYYY-MM-DD", "title": "Legs" }],
  "runs": [{ "day": "YYYY-MM-DD", "intensity": "moderate", "distance_km": null, "duration_min": 61 }],
  "readiness": { "day": "YYYY-MM-DD", "score": 86, "hrv_balance": 82, "resting_heart_rate": 73, "recovery_index": 100 },
  "sleep": { "day": "YYYY-MM-DD", "score": 84 },
  "nutrition": {
    "stats": { "windows": { "d7": {}, "d14": {}, "d28": {} }, "weight": {}, "protein": {}, "energy_balance": {} },
    "days": [{ "date": "YYYY-MM-DD", "kcal": 2980, "protein_g": 165, "carbs_g": 320, "fat_g": 95, "weight_kg": 78.4 }]
  },
  "errors": []
}
```

`nutrition` is null unless `INGEST_TOKEN` is set. It comes from Apple Health, not
an API: MacroFactor has none, so it writes into Apple Health, and Health Auto
Export on the iPhone POSTs that to the breathing-bot Worker, which is where this
reads it from. Every figure under `stats` is precomputed there (averages, protein
g/kg, least-squares weight trend, inferred TDEE) with a verdict band attached, so
the coach model reports rather than calculates. See the breathing-bot README for
the phone-side setup.

## Crypto

Two formats; every script reads both (`crypto-lib.js`).

- **v1** (current default for writes): `base64(iv[16] || AES-256-CBC(sha256(FITNESS_KEY), plaintext))`.
  No integrity check, and the key is one unsalted hash, so the passphrase is
  only as strong as it is long and random.
- **v2**: `"v2:" + base64(salt[16] || iv[12] || tag[16] || AES-256-GCM(key, plaintext))`,
  `key = scrypt(FITNESS_KEY, salt, N=32768, r=8, p=1, 32 bytes)`. Authenticated
  and memory-hard.

Writes switch to v2 when the repo **variable** `ENC_FORMAT` is `v2` (Settings >
Secrets and variables > Actions > Variables). Do it in this order, because the
brief routine decrypts `fitness.json.enc` outside this repo:

1. Teach the brief routine to read both formats:

   ```js
   const crypto = require("crypto");
   function decryptSnapshot(text, passphrase) {
     const t = text.trim();
     if (t.startsWith("v2:")) {
       const b = Buffer.from(t.slice(3), "base64");
       const key = crypto.scryptSync(passphrase, b.subarray(0, 16), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
       const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(16, 28));
       d.setAuthTag(b.subarray(28, 44));
       return JSON.parse(Buffer.concat([d.update(b.subarray(44)), d.final()]).toString("utf8"));
     }
     const b = Buffer.from(t, "base64");
     const d = crypto.createDecipheriv("aes-256-cbc", crypto.createHash("sha256").update(passphrase).digest(), b.subarray(0, 16));
     return JSON.parse(Buffer.concat([d.update(b.subarray(16)), d.final()]).toString("utf8"));
   }
   ```
2. Set `ENC_FORMAT=v2`. The next run of each workflow rewrites its files in v2.

v2 protects new snapshots only. Everything already committed stays v1 in the
git history under the current passphrase; `docs/worker-contract.md` covers
rotating the key and purging that history.

Run manually: Actions tab > fetch-fitness > Run workflow.

## Meditation notifier

A second workflow (`.github/workflows/meditation.yml`, hourly, or at once on an
`oura_new_data` dispatch) runs
`meditation.js`: it pulls the Oura `session` endpoint (last 21 days), classifies
each session by start time (before noon = Wim Hof, midday onwards = resonance),
computes per-session stats (HR/HRV start-end-min-max, per-minute averages, and
the full raw series for the 6 most recent sessions) plus per-practice baselines
and streaks, and commits `meditation.json.enc` (same crypto, same `FITNESS_KEY`).
When the whole 21-day window holds no session the practice is treated as
dormant: the poll keeps running, but the Sunday digest stops sending "0
sessions" notes and resumes by itself the week a session appears.
Oura's declared series interval is unreliable, so the effective interval is
derived from duration / item count, and nulls stay in the series to preserve
the index-to-time mapping.

Each session carries `first_seen`: the timestamp of the relay run that first
saw it. On bootstrap (no previous file, or an unreadable one) everything is
marked `first_seen = epoch` so nothing looks new.

## Slack notifier + weekly digest (all in GitHub Actions)

Notifications are generated and sent entirely from GitHub Actions (no claude.ai
routine, no per-action quota):

- `notify.js` runs in `meditation.yml` right after `meditation.js`. It decrypts
  the snapshot, finds sessions not in the committed `notified.json.enc` set,
  composes a per-session summary, and posts it to Slack. First run bootstraps
  the notified set silently.
- `digest.js` runs in `digest.yml` (Sunday 17:00 UTC) and posts a weekly recap.
- `breathing-lib.js` holds the shared crypto + analysis (3-hold detection for
  Wim Hof, settle/steadiness/HRV-lift for resonance) and the message composer.

Message text is written by Claude via the Anthropic API when `ANTHROPIC_API_KEY`
is set; otherwise a built-in deterministic template is used, so the pipeline
never hard-depends on the API. `DRY_RUN=1` prints instead of sending.

### Extra secrets for notifications

- `SLACK_BOT_TOKEN` - Slack bot token with `chat:write` (and `im:write` to DM).
  Missing -> messages are composed and logged but not sent.
- `ANTHROPIC_API_KEY` - optional; enables Claude-written messages.
- `SLACK_USER_ID` - optional; defaults to Wilhelm's DM id.

Old approach (retired): an hourly claude.ai "Meditation summary" routine polled
the raw `.enc` file. Replaced by the in-Actions notifier above.
