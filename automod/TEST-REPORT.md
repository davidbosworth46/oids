# Test Report — Oids Automod (incl. billing hardstop)

Date: 2026-09-27. All tests below ran against **local** Cloudflare emulation
(`wrangler dev`) and plain-node unit tests. **Nothing was deployed; production
is untouched.**

## 1. Billing guard — unit tests (`/tmp/guard-test.mjs`, stubbed fetch + in-memory KV/DB)

**34/34 passed.**

| # | Case | Result |
|---|---|---|
| 1 | WARN tier dry-run (300k/day vs synthetic warn 250k / kill 1M) | warnTripped, dryRun flagged, `oids:kill` NOT written, `[dry-run] WOULD warn` log + notification |
| 2 | KILL tier dry-run (1.5M/day) | killTripped, dryRun flagged, `oids:kill` NOT written, `[dry-run] WOULD flip oids:kill` log + `[dry-run] WOULD trip the kill switch` notification |
| 3 | Per-worker series trips first (automod 300k, account 350k) | warnTripped via worker series; detail attributes the worker |
| 4 | Below thresholds (50k/day) | quiet, no trips, no notifications |
| 5 | Hourly throttle | second call within the hour returns throttled, no duplicate work |
| 6 | GraphQL failure, **live mode** | fails safe: no trip, `oids:kill` NOT written, error notification queued |
| 7 | Missing CF_API_TOKEN | guard inert, single "token missing" notification |
| 8 | AI daily cap boundary (999/1000 → 1000/1000) | 1000th call allowed, 1001st denied, one cap-exhausted notice, counter stays at 1000 |
| 9 | Live-mode kill path (mock KV only) | `oids:kill` written, URGENT notification; latched — no duplicate URGENT on the next hour |

## 2. Billing guard — end-to-end (`wrangler dev`, automod worker, fake token)

- Triggered `/__scheduled` on the real bundled worker: sweep + guard executed.
- Guard with an invalid token: `billing_guard` mod-log row
  "account lookup failed", error notification queued, **`oids:kill` absent
  from KV** — fail-safe path verified end to end.
- KV after run: `automod:wm:guard` set (hourly throttle armed), watermarks
  advanced, `oids:kill` not present.

## 3. Cloudflare API probes (read-only, real account)

- **GraphQL usage query shape validated live**: `workersInvocationsAdaptive`
  with `sum { requests }` and `dimensions { scriptName }` returned
  `{"scriptName":"oids","requests":377}` for the trailing 24h. The guard's
  exact query (account total + per-worker series) is confirmed working.
- **Notification-policies API: not available.** `/accounts/{id}/alerting/v3/*`
  returns authentication error on this token; legacy
  `/notification-policies` has no route. Billing alerts **cannot** be created
  via API — the operator must do it in the dashboard (path documented in README.md
  and CUTOVER.md).

## 4. Scheduled sweep — end-to-end (dry-run, `AUTOMOD_DRY_RUN="1"`)

Synthetic data from the earlier session (scam post, link spam, federal child-
pattern post, threat post, piracy post, duplicate, 2 DMs incl. one blocked
federal DM):

- Scam post: `delete_post` logged with `[dry-run]` — **post NOT deleted**
  (7/7 posts still live).
- Threat + piracy posts: queued in `review_queue` (2 open), **AI unavailable
  in dev → queued with `ai_verdict = NULL`** (documented no-AI fallback works).
- Blocked federal DM: packaged; DM watch: "New DM to @oidsadmin" notifications
  queued for both DMs (nothing marked read).
- Second scheduled run: **idempotent** — moderation_log stayed at 9 rows, no
  reprocessing, guard throttled.

## 5. Static checks

- `node --check` passes on all automod modules; `worker.js` / `sweep.js` /
  `email.js` import cleanly in node (validates the module graph the way
  wrangler bundles it).
- Public worker `fetch` routes unaffected: `GET /` on the automod worker
  returns 404 (no public surface); the main worker's scheduled/email handlers
  were reverted per the two-worker billing design.

## 6. Not yet tested (needs production or the operator)

- Real Workers AI verdict path (token lacked AI permission; dev had no AI
  binding) — the no-AI fallback is tested, the AI-present path is code-
  reviewed only.
- Real Email Routing delivery to the email handler.
- The guard against **live** account usage (needs the narrow
  Account-Analytics-Read token as a worker secret, set at cutover).
- Abuse-email AI triage: not yet implemented (must respect the AI daily cap
  when added).

## Residual risk (stated plainly)

- Guard reacts **hourly**: a fast flood can run up to ~1 hour before the
  switch trips.
- **$5/month Workers Paid base is unavoidable** (cron + Workers AI).
- Worst case before the guard trips is bounded by the **1M/day kill
  threshold** (~$10 overage equivalent at sustained flood levels).
- Dashboard billing alerts are informational only — they cap nothing.
