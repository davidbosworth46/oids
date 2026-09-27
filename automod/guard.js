/**
 * automod/guard.js — hourly billing hardstop for Oids.
 *
 * Cloudflare offers no native "never charge me more than $X" switch, so this
 * guard builds one:
 *
 *   1. Once per hour (throttled inside the 15-min cron), it queries the
 *      Cloudflare GraphQL Analytics API for Workers requests over the
 *      trailing 24h — BOTH the account total AND the oids-automod worker's
 *      own series (per-script breakdown via the scriptName dimension).
 *      Whichever series hits a tier first trips it.
 *   2. WARN tier (USAGE_WARN_THRESHOLD_PER_DAY, default 250,000/day):
 *      urgent notification so a human looks at the traffic. Once per day.
 *   3. KILL tier (USAGE_KILL_THRESHOLD_PER_DAY, default 1,000,000/day):
 *      flips the shared KV kill switch (oids:kill = "1") — the same switch
 *      the API worker honors with HTTP 503 on every route, and which
 *      ../kill.sh sets manually. Then queues an urgent notification.
 *      Recover with ../revive.sh after reviewing the flood source.
 *   4. On any API error (bad token, missing permission, schema change) it
 *      NEVER flips the switch: unknown state fails safe, not armed.
 *
 * Why these numbers: legitimate Oids traffic is plausibly under 100k/day,
 * so 1M/day is ~10x headroom. A sustained 1M/day flood is ~30M/month, about
 * $10 over the 10M requests included on Workers Paid — vs ~$70 at the old
 * 5M/day threshold. Both thresholds are documented tunable constants and
 * can be overridden without a code change via the USAGE_WARN_THRESHOLD /
 * USAGE_KILL_THRESHOLD worker vars.
 *
 * Honest limits (do not oversell this):
 *   - The guard reacts hourly. A fast flood can run for up to ~1 hour before
 *     the switch trips. Pair it with David's account-level usage billing
 *     alerts in the Cloudflare dashboard (see README.md).
 *   - The $5/month Workers Paid base for the oids-automod worker is
 *     unavoidable (cron + Workers AI require Paid).
 *   - L3/L4/L7 DDoS mitigation is unmetered, so the bill risk is floods that
 *     look legitimate — which is exactly what this guard covers.
 *
 * Needs `wrangler secret put CF_API_TOKEN` on the oids-automod worker: a
 * narrow token with Account Analytics: Read permission (NOT the broad deploy
 * token). Optionally set CF_ACCOUNT_ID (var) to skip account auto-detection.
 */

import { logMod } from './db.js';
import { notify } from './notify.js';

/**
 * WARN tier: urgent notification. Default 250,000 Workers requests/day.
 * Override with the USAGE_WARN_THRESHOLD worker var.
 */
export const USAGE_WARN_THRESHOLD_PER_DAY = 250_000;

/**
 * KILL tier: flip KV oids:kill. Default 1,000,000 Workers requests/day.
 * Override with the USAGE_KILL_THRESHOLD worker var.
 */
export const USAGE_KILL_THRESHOLD_PER_DAY = 1_000_000;

/**
 * Hard daily cap on Workers AI classification calls. Beyond this, gray-area
 * items go straight to the human-review queue with NO AI call — AI spend is
 * structurally unable to spike. Overshoot of 1-2 calls is possible under
 * concurrency (KV is eventually consistent); that is acceptable.
 */
export const AI_CALLS_PER_DAY_MAX = 1_000;

const GUARD_INTERVAL_MS = 3_600_000; // hourly
const KV_LAST_RUN = 'automod:wm:guard';
const KV_UNCONFIGURED_FLAG = 'automod:guard-unconfigured-notified';
const KILL_KEY = 'oids:kill';
const DEFAULT_WORKER_NAME = 'oids-automod';

/** GraphQL Analytics API: POST /client/v4/graphql. Returns {data, errors} (no success wrapper). */
async function cfGraphQL(token, query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) {
    throw new Error('GraphQL: ' + j.errors.map((e) => e.message).join('; ').slice(0, 300));
  }
  return j.data;
}

async function cfRest(token, path) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!j.success) {
    throw new Error(`REST ${path}: ${(j.errors || []).map((e) => e.message).join('; ').slice(0, 200)}`);
  }
  return j.result;
}

const USAGE_QUERY = `query($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        filter: {datetime_geq: $start, datetime_leq: $end}
        limit: 10000
      ) {
        sum { requests }
        dimensions { scriptName }
      }
    }
  }
}`;

/**
 * Trailing-24h Workers request counts: { total, perWorker }.
 * perWorker is the series for the automod worker itself; total covers the
 * whole account (both workers). Query shape verified live 2026-09-27.
 */
export async function fetchDailyWorkersUsage(token, accountTag, workerName) {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3_600_000);
  const data = await cfGraphQL(token, USAGE_QUERY, {
    accountTag,
    start: start.toISOString(),
    end: end.toISOString(),
  });
  const rows = (((data || {}).viewer || {}).accounts || [])[0]?.workersInvocationsAdaptive || [];
  let total = 0;
  let perWorker = 0;
  for (const r of rows) {
    const n = ((r || {}).sum || {}).requests || 0;
    total += n;
    if (((r || {}).dimensions || {}).scriptName === workerName) perWorker += n;
  }
  return { total, perWorker };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Claim one Workers AI call against the daily hard cap.
 * Returns true (and consumes the call) while budget remains, false when the
 * cap is hit — callers must then queue for human review WITHOUT an AI call.
 */
export async function claimAiCall(env) {
  const key = `automod:ai-calls:${todayKey()}`;
  const used = parseInt((await env.KV.get(key)) || '0', 10) || 0;
  if (used >= AI_CALLS_PER_DAY_MAX) {
    // One notification per day when the cap starts biting.
    const flagKey = `automod:ai-cap-notified:${todayKey()}`;
    if (!(await env.KV.get(flagKey))) {
      await notify(env, 'info', 'AI triage budget exhausted for today',
        `Workers AI classification hit its ${AI_CALLS_PER_DAY_MAX}/day hard cap. ` +
        `Gray-area items are going to the human-review queue with no AI verdict until the cap resets.`);
      await env.KV.put(flagKey, '1', { expirationTtl: 172800 });
    }
    return false;
  }
  await env.KV.put(key, String(used + 1), { expirationTtl: 172800 });
  return true;
}

/**
 * Run the hourly billing guard. Returns a summary object.
 * `dry` (AUTOMOD_DRY_RUN="1") logs what it WOULD do without flipping oids:kill.
 */
export async function runUsageGuard(env, dry) {
  // Hourly cadence (called from the 15-min cron).
  const last = parseInt((await env.KV.get(KV_LAST_RUN)) || '0', 10) || 0;
  if (Date.now() - last < GUARD_INTERVAL_MS) return { ran: false, reason: 'throttled' };
  await env.KV.put(KV_LAST_RUN, String(Date.now()));

  const warnThreshold = parseInt(env.USAGE_WARN_THRESHOLD || '', 10) || USAGE_WARN_THRESHOLD_PER_DAY;
  const killThreshold = parseInt(env.USAGE_KILL_THRESHOLD || '', 10) || USAGE_KILL_THRESHOLD_PER_DAY;
  const workerName = env.AUTOMOD_WORKER_NAME || DEFAULT_WORKER_NAME;

  const token = env.CF_API_TOKEN;
  if (!token) {
    // Notify once so the drain cron surfaces it, then stay quiet.
    if (!(await env.KV.get(KV_UNCONFIGURED_FLAG))) {
      await notify(env, 'error', 'Billing guard inert: CF_API_TOKEN missing',
        'The hourly usage guard has no API token, so the billing hardstop is OFF. ' +
        'Create a narrow Cloudflare token (Account -> Account Analytics: Read) and run ' +
        '`wrangler secret put CF_API_TOKEN` on the oids-automod worker, then clear ' +
        'KV key automod:guard-unconfigured-notified to re-arm this notice.');
      await env.KV.put(KV_UNCONFIGURED_FLAG, '1');
    }
    return { ran: false, reason: 'no-token' };
  }

  let accountTag;
  try {
    accountTag = env.CF_ACCOUNT_ID || (await cfRest(token, '/accounts'))[0]?.id;
    if (!accountTag) throw new Error('no accounts returned');
  } catch (e) {
    await logMod(env, 'billing_guard', 'account', null, `account lookup failed: ${String(e).slice(0, 200)}`, 'automod');
    await notify(env, 'error', 'Billing guard error: account lookup failed',
      `Could not resolve the Cloudflare account ID; guard did NOT flip the switch. ${String(e).slice(0, 200)}`);
    return { ran: true, tripped: false, reason: 'account-error' };
  }

  let usage;
  try {
    usage = await fetchDailyWorkersUsage(token, accountTag, workerName);
  } catch (e) {
    await logMod(env, 'billing_guard', 'account', null, `usage query failed: ${String(e).slice(0, 200)}`, 'automod');
    await notify(env, 'error', 'Billing guard error: usage query failed',
      `GraphQL usage query failed; guard did NOT flip the switch. ${String(e).slice(0, 200)}`);
    return { ran: true, tripped: false, reason: 'query-error' };
  }

  const { total, perWorker } = usage;
  const peak = Math.max(total, perWorker);
  const peakLabel = peak === perWorker && perWorker !== total ? `worker "${workerName}"` : 'account total';
  const detail =
    `Trailing 24h Workers requests: account total ${total.toLocaleString('en-US')}, ` +
    `"${workerName}" ${perWorker.toLocaleString('en-US')}. ` +
    `Warn tier ${warnThreshold.toLocaleString('en-US')}/day, kill tier ${killThreshold.toLocaleString('en-US')}/day.`;

  const result = { ran: true, tripped: false, warnTripped: false, killTripped: false, total, perWorker, warnThreshold, killThreshold };

  // KILL tier first (highest severity). Whichever series hits first trips.
  if (peak >= killThreshold) {
    result.killTripped = true;
    if (dry) {
      await logMod(env, 'billing_guard', 'account', null, `[dry-run] WOULD flip ${KILL_KEY} (${peakLabel} hit kill tier): ${detail}`, 'automod');
      await notify(env, 'error', '[dry-run] Billing guard WOULD trip the kill switch',
        `${detail} In live mode this flips KV oids:kill to "1" (API returns 503 on every route). ` +
        `Recover with ./revive.sh after reviewing the flood source.`);
      return { ...result, dryRun: true };
    }
    // Already flipped? Don't re-notify hourly; the switch is latched.
    if ((await env.KV.get(KILL_KEY)) === '1') return { ...result, alreadyTripped: true };
    await env.KV.put(KILL_KEY, '1');
    await logMod(env, 'billing_guard', 'account', null, `FLIPPED ${KILL_KEY} (${peakLabel} hit kill tier): ${detail}`, 'automod');
    await notify(env, 'error', 'URGENT: billing guard tripped the kill switch',
      `${detail} KV oids:kill is now "1"; the API is returning 503 on every route. ` +
      `Investigate the flood source, then recover with ./revive.sh.`);
    return result;
  }

  // WARN tier: urgent notification, once per day.
  if (peak >= warnThreshold) {
    result.warnTripped = true;
    const flagKey = `automod:guard-warned:${todayKey()}`;
    const prefix = dry ? '[dry-run] Billing guard WOULD warn' : 'Billing guard WARNING: usage above warn tier';
    if (!(await env.KV.get(flagKey))) {
      await logMod(env, 'billing_guard', 'account', null, `${dry ? '[dry-run] ' : ''}WARN tier hit (${peakLabel}): ${detail}`, 'automod');
      await notify(env, 'error', prefix,
        `${detail} This is the warn tier — no switch flipped. If usage keeps climbing toward the kill tier ` +
        `(${killThreshold.toLocaleString('en-US')}/day), the guard will flip KV oids:kill to "1".`);
      await env.KV.put(flagKey, '1', { expirationTtl: 172800 });
    }
    return { ...result, dryRun: dry || undefined };
  }

  return result;
}
