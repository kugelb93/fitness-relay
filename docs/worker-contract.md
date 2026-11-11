# What is left: the Worker side, and the history purge

This repo is done as far as it can go alone. The rest happens in the
breathing-bot Worker (a separate codebase) and in the repo's settings. Listed in
the order that pays off soonest.

## 1. Fire the workflows on time (small)

GitHub's cron is hours late (table in the README). The Worker's cron triggers are
punctual, so have it send `repository_dispatch` events:

```js
// wrangler.toml:  [triggers] crons = ["*/15 * * * *"]   (then gate on local time)
async function dispatch(env, eventType) {
  const r = await fetch("https://api.github.com/repos/kugelb93/fitness-relay/dispatches", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "relay-dispatch",
    },
    body: JSON.stringify({ event_type: eventType }),
  });
  if (r.status !== 204) throw new Error(`dispatch ${eventType}: ${r.status}`);
}
```

Gate on Stockholm local time inside the handler rather than in the cron
expression, so nothing shifts at the DST changes:

| Local time (Europe/Stockholm) | `event_type` |
|---|---|
| 06:45 daily, 09:00 daily | `fetch_fitness` |
| 07:00 daily | `daily_line` |
| Monday 07:15 | `weekly_coach` |
| on the Oura `session` webhook | `oura_new_data` |

`GITHUB_DISPATCH_TOKEN` is a fine-grained personal access token scoped to this
one repository with **Contents: read and write** (that is the permission the
dispatches endpoint requires). Store it with `wrangler secret put`, never in the
repo.

Nothing else has to change for this step: the crons here remain as fallbacks and
`coach.js` will not double-send.

## 2. Keep `checks` in the targets ledger (tiny)

`coach.js` now POSTs `checks` (an array) on each record to `/ingest/targets` and
expects it back from `/export/targets`. If the Worker whitelists fields, add
`checks` to the list. Until then `coach.js` falls back to storing the record
without it and grading in prose, exactly as before, so nothing breaks.

## 3. Let him answer the coach (medium)

The coach is still one-way. To close the loop the Worker, which already receives
his Slack messages, should store replies to the weekly readout and serve them:

- `GET /export/notes?weeks=4` (bearer `INGEST_TOKEN`) ->
  `{ "notes": [{ "week": "2026-W46", "date": "2026-11-11", "text": "skipped Upper B, travelling" }] }`

`coach.js` would then pass `notes` into the payload beside `targets`, with one
prompt rule: a stated reason for a miss is context, not an excuse, and it changes
the advice (a travel week is not an adherence problem). This is not wired on the
relay side yet, on purpose: the endpoint does not exist, and code written against
a guessed shape would have to be redone.

## 4. Have the engine read program.json (small)

The progression engine carries its own copy of the routines. `program.json` is
now the single description of the split for the relay and the coach prompt; the
engine can fetch it from
`https://raw.githubusercontent.com/kugelb93/fitness-relay/main/program.json`
so that all three agree. It holds set counts only; rep and kg targets stay the
engine's.

## 5. Move the data out of git (the large one)

Today the encrypted snapshots are committed to a public repo twice a day and
stay in its history for good. Target shape:

1. The Worker stores the snapshot (KV or D1) behind `INGEST_TOKEN`:
   `POST /ingest/snapshot` from `fetch.js`, `GET /export/snapshot` for readers.
2. The brief routine reads `/export/snapshot` instead of the raw GitHub URL.
   Check first that its sandbox can reach `*.workers.dev`; GitHub was chosen
   originally because the sandbox could reach it.
3. `history.json.enc` and `notified.json.enc` are state, not output. Run
   history can be rebuilt from Oura (its workout endpoint takes any start date,
   the same discovery that fixed the recovery backfill); the notified set moves
   to the Worker with the snapshot.
4. The commit steps come out of `fetch.yml` and `meditation.yml`, and the `.enc`
   files are deleted from the tree.

Fetching Hevy and Oura from the Worker itself, with no Actions at all, is the
end state, and it is a port of `fetch.js` (no dependencies, built-in `fetch`)
rather than a rewrite.

## 6. Rotate the key and purge the history (destructive, yours to run)

Every snapshot since 2026-07-22 is in the history, encrypted in v1 under the
current `FITNESS_KEY`. Removing the files from the tree does not remove them from
history, and anything already cloned or forked elsewhere stays out there, so the
order matters:

1. Switch to v2 (README, "Crypto") and set a **new** `FITNESS_KEY`: a random
   passphrase of at least 20 characters. Update the secret here, in the Worker
   if it holds one, and in the brief routine. Delete the four `.enc` files and
   let the next runs regenerate them under the new key (`notify.js` and
   `meditation.js` both bootstrap silently when their file is missing, so
   nothing is re-announced).
2. Then, and only if you want the old ciphertext gone from GitHub as well,
   rewrite history:

   ```sh
   git clone https://github.com/kugelb93/fitness-relay && cd fitness-relay
   pipx run git-filter-repo --invert-paths --path-glob '*.enc' --force
   git remote add origin https://github.com/kugelb93/fitness-relay
   git push --force origin main
   ```

   This rewrites every commit hash, breaks open branches and PRs, and cannot be
   undone. Disable the workflows while you do it so a snapshot commit does not
   race the push. GitHub keeps unreachable commits for a while; their support can
   expire them on request.

Step 1 is what actually protects the data: once the old passphrase decrypts
nothing new, the history holds only what was already public.
