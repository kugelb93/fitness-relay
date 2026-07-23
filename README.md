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
`meditation.js`: it pulls the Oura `session` endpoint (last 21 days), computes
per-session stats (duration, HR/HRV start-end-min-max, 12-point curves, mood)
plus rolling stats (streak, sessions last 7 days, 21-day averages), and commits
`meditation.json.enc` (same crypto, same `FITNESS_KEY`).

Each session carries `first_seen`: the timestamp of the relay run that first
saw it. On bootstrap (no previous file, or an unreadable one) everything is
marked `first_seen = epoch` so nothing looks new. The hourly "Meditation
summary" cloud routine decrypts the file and DMs a summary for any session
whose `first_seen` falls inside its last polling window.
