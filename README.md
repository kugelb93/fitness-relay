# fitness-brief

Relay that feeds the daily Slack brief a workout suggestion.

The brief runs as a cloud routine in a sandbox whose network proxy blocks
`api.hevyapp.com` and `api.ouraring.com`. GitHub *is* reachable from that
sandbox, so this repo bridges the gap:

1. A GitHub Actions cron (`.github/workflows/fetch.yml`) runs each morning,
   calls Hevy + Oura, and commits an **encrypted** `fitness.json.enc`.
2. The brief routine reads `fitness.json.enc` from the public raw URL, decrypts
   it with a shared passphrase, and turns it into the "Training" section.

This repo is public, so nothing readable is ever written: the payload is
AES-256-CBC encrypted and the workflow logs counts only, never values.

## Secrets (repo settings > Secrets and variables > Actions)

- `HEVY_API_KEY` - Hevy Pro API key
- `OURA_TOKEN` - Oura v2 Personal Access Token
- `FITNESS_KEY` - shared passphrase; key = sha256(passphrase). The routine holds
  the same value.

## Decrypted payload shape

```json
{
  "generated_at": "ISO-8601 UTC",
  "strength": [{ "date": "YYYY-MM-DD", "title": "Legs" }],
  "runs": [{ "day": "YYYY-MM-DD", "intensity": "moderate", "distance_km": null, "duration_min": 61 }],
  "readiness": { "day": "YYYY-MM-DD", "score": 86, "hrv_balance": 82, "resting_heart_rate": 73, "recovery_index": 100 },
  "sleep": { "day": "YYYY-MM-DD", "score": 84 },
  "errors": []
}
```

Crypto: `fitness.json.enc` = base64(iv[16] || AES-256-CBC(sha256(FITNESS_KEY), plaintext)).

Run manually: Actions tab > fetch-fitness > Run workflow.

## Meditation notifier

A second workflow (`.github/workflows/meditation.yml`, every 20 min) runs
`meditation.js`: it pulls the Oura `session` endpoint (last 21 days), classifies
each session by duration (under 14 min = resonance breathing, 14+ = Wim Hof),
computes per-session stats (HR/HRV start-end-min-max, per-minute averages, and
the full raw series for the 6 most recent sessions) plus per-practice baselines
and streaks, and commits `meditation.json.enc` (same crypto, same `FITNESS_KEY`).
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
  composes a per-session summary, and posts it to Slack. New sessions surface
  within one 20-minute poll. First run bootstraps the notified set silently.
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
