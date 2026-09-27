# Cutover Plan — Oids Autonomous Moderation

**Do not deploy until the operator approves this plan.** Production is unchanged
until every step below is done in order. Nothing here is automated; each step
needs a human go-ahead.

## Pre-flight (Cloudflare account)

- [ ] **Verify/upgrade Workers Paid.** The `oids-automod` worker needs the
      Paid plan ($5/mo base, unavoidable) for cron triggers + Workers AI.
      Check: Cloudflare dashboard → Workers & Pages → Plans/usage. The public
      `oids` worker stays on **Free** (rejected-not-billed = hard cap).
      (API token could not verify the Workers subscription tier — needs the
      dashboard.)
- [ ] **Billing alerts (operator, dashboard only).** The API cannot create
      usage/billing alerts (alerting API auth-errors on this token; no
      notification-policies route). In the dashboard: dash.cloudflare.com → account →
      **Manage Account → Notifications** → Budget alert ($10, $25) + optional
      Workers usage-based alert. Informational only; the worker guard is the
      enforced ceiling. See README.md "Operator's part".

## Tokens and secrets (least privilege)

- [ ] Create a **narrow** Cloudflare token: **Account → Account Analytics →
      Read** only. Store as a worker secret (never in code or vars):
      `wrangler secret put CF_API_TOKEN --config automod/wrangler.toml`
      (this powers the billing guard; it is NOT the deploy token).
- [ ] Grant the **deploy token** only: Workers (oids-automod) edit, D1 edit,
      KV edit, Workers AI run, Email Routing edit. Nothing broader.
- [ ] Optional notification fan-out: `wrangler secret put RESEND_API_KEY`
      and set `NOTIFY_EMAIL` var — only if the operator supplies a key and
      destination. Otherwise the D1 queue + drain script is the sink.

## Data

- [ ] Apply migration to **production** D1:
      `wrangler d1 execute oids-db --remote --file automod/migrations/004_automod.sql`
      (adds `review_queue`, `federal_incidents`, `notifications`).
- [ ] Seed production KV watermarks at **current maxima** (posts, DMs,
      modlog) so the first sweep does not replay history.
- [ ] Seed private dox patterns from `~/.oids-dox-patterns` into KV key
      `automod:dox-patterns`. **Never print or commit them.**

## Deploy (dry-run first)

- [ ] Deploy with `AUTOMOD_DRY_RUN="1"`:
      `wrangler deploy --config automod/wrangler.toml`
- [ ] **Do NOT touch the public `oids` worker.** Its wrangler.toml has no
      `[triggers]`/`[ai]`; redeploying it is unnecessary and must not move it
      to Paid.
- [ ] Run at least one synthetic dry-run: insert a synthetic scam post + a
      synthetic federal-pattern post, wait for a cron tick, then verify in D1:
      posts NOT deleted, keys NOT revoked, proposed actions logged with
      `[dry-run]`, incident package rows with `dry_run=1`, review-queue rows,
      notification rows, KV watermarks advanced. Delete the synthetic rows
      after.
- [ ] Verify the billing guard in dry-run: temporarily set
      `USAGE_WARN_THRESHOLD="1"` / `USAGE_KILL_THRESHOLD="1"` vars, wait for
      the hourly guard, confirm `[dry-run] WOULD warn` / `WOULD flip`
      log + notification rows and that `oids:kill` was **not** set. Restore
      the real thresholds after.

## Email

- [ ] Cloudflare dashboard → **Email → Email Routing**: route
      `abuse@tryoids.com` to the `oids-automod` worker. (API token could not
      verify Email Routing state — needs the dashboard.)

## Go live

- [ ] Set `AUTOMOD_DRY_RUN="0"` (var) and redeploy **only after** the dry-run
      evidence above is reviewed.
- [ ] Confirm the first live sweep in D1 logs within 30 minutes.

## Retire the old machinery (only after live verification)

- [ ] Disable/reduce cron `oids-mod-sweep`.
- [ ] Disable/reduce cron `oids-abuse-watch`.
- [ ] Keep human handling for: federal browser filings, legal judgment,
      deploys, exceptional key-review decisions.

## Rollback

- `../kill.sh` flips `oids:kill` (API → 503) without touching data.
- `../revive.sh` removes the flag (recovery can take ~60s via KV propagation).
- To fully stand down automod: `wrangler delete --config automod/wrangler.toml`
  (D1 rows and KV watermarks remain for audit).
