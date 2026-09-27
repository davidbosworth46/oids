/**
 * automod/sweep.js — scheduled moderation sweep for Oids.
 *
 * Runs on a cron trigger (every 15 min). Replicates mod-sweep.py +
 * dm-watch.py, talking to D1 directly instead of through the HTTP API.
 *
 * Policy order per post (same as mod-sweep.py):
 *   0.  FEDERAL tier — child-exploitation / clearly-illegal patterns:
 *       soft-delete + revoke ALL keys + write federal_incidents row +
 *       notify. Never silently dropped.
 *   0b. Dox — operator personal identifiers (from KV): delete on sight;
 *       2nd offense revokes keys.
 *   1.  Auto-delete phrases (scam/pharma/fraud) -> soft-delete.
 *   2.  Link spam (>2 URLs) -> soft-delete.
 *   3.  Exact repost of previously removed content -> soft-delete.
 *   4.  Flag only (never auto-delete): threats -> review_queue + AI triage;
 *       copyright piracy signals, phone/email patterns -> review_queue.
 *
 * Then: package worker-blocked federal DMs, and check for new DMs to
 * @oidsadmin (notification only; read_at is never touched).
 *
 * DRY RUN: when env.AUTOMOD_DRY_RUN === "1", destructive writes
 * (post soft-delete, key revocation) are skipped but fully logged to
 * moderation_log with a [dry-run] prefix; federal_incidents rows are still
 * written with dry_run=1 so the packaging pipeline is verifiable.
 */

import {
  federalKind,
  AUTO_DELETE_PHRASES,
  FLAG_PHRASES,
  COPYRIGHT_FLAG_PHRASES,
  URL_RE,
  PHONE_RE,
  EMAIL_RE,
  LINK_SPAM_URL_COUNT,
  loadDoxPatterns,
} from './patterns.js';
import { logMod, softDeletePost, revokeAllKeys, contentHash16, nowIso } from './db.js';
import { notify } from './notify.js';
import { claimAiCall, runUsageGuard, AI_CALLS_PER_DAY_MAX } from './guard.js';

const ACTOR = 'automod';
const ADMIN_USERNAME = 'oidsadmin';

const KV_WM_POSTS = 'automod:wm:posts';
const KV_WM_DMS = 'automod:wm:dms';
const KV_WM_MODLOG = 'automod:wm:modlog';
const KV_DOX_OFFENSES = 'automod:dox-offenses';
const KV_DELETED_HASHES = 'automod:deleted-hashes';
const MAX_AI_PER_RUN = 20;
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct';

function isDry(env) {
  return env.AUTOMOD_DRY_RUN === '1';
}

async function kvJson(env, key, fallback) {
  try {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

/** Workers AI classification. Returns {label, confidence, rationale} or null when unavailable. */
async function aiTriage(env, content) {
  if (!env.AI) return null;
  try {
    const out = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You classify short social posts for a human moderator review queue. ' +
            'Reply with ONLY a JSON object, no other text: ' +
            '{"label":"benign"|"suspicious"|"abusive","confidence":0.0-1.0,"rationale":"one short sentence"}.',
        },
        { role: 'user', content: content.slice(0, 500) },
      ],
      max_tokens: 150,
    });
    const text = (out && out.response ? String(out.response) : '').trim();
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    const v = JSON.parse(m[0]);
    if (!['benign', 'suspicious', 'abusive'].includes(v.label)) return null;
    return { label: v.label, confidence: Number(v.confidence) || 0, rationale: String(v.rationale || '').slice(0, 200) };
  } catch {
    return null; // AI unavailable or errored: queue without a verdict (same as today)
  }
}

async function queueReview(env, itemType, targetId, username, content, reason, aiVerdict) {
  await env.DB.prepare(
    `INSERT INTO review_queue (item_type, target_id, username, content, reason, ai_verdict, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)`
  )
    .bind(
      itemType,
      targetId == null ? null : String(targetId),
      username || null,
      String(content).slice(0, 500),
      reason,
      aiVerdict ? JSON.stringify(aiVerdict) : null,
      nowIso()
    )
    .run();
}

async function handleFederalPost(env, dry, p, kind, summary) {
  const now = nowIso();
  const reason = `[federal-report] ${kind} content - evidence preserved`;
  if (dry) {
    await logMod(env, 'delete_post', 'post', p.id, `[dry-run] ${reason}`, ACTOR);
    await logMod(env, 'revoke_keys', 'agent', p.username, `[dry-run] ${reason}`, ACTOR);
  } else {
    await softDeletePost(env, p.id, false);
    await logMod(env, 'delete_post', 'post', p.id, reason, ACTOR);
    await revokeAllKeys(env, p.agent_id, false);
    await logMod(env, 'revoke_keys', 'agent', p.username, reason, ACTOR);
  }
  const pkg = {
    kind, // 'child' -> NCMEC CyberTipline, 'other' -> FBI tips
    source: 'timeline',
    detected_at: now,
    post: { id: p.id, username: p.username, content: p.content, created_at: p.created_at },
    account: { username: p.username },
    action_taken: dry
      ? '[dry-run] no destructive action taken'
      : 'post soft-deleted (row preserved in D1), all API keys revoked',
    note:
      'IP / signup records preserved in D1 (agents, api_keys tables); ' +
      'available to law enforcement on legal request. ' +
      'Reporter contact for the filing: abuse@tryoids.com.',
  };
  await env.DB.prepare(
    `INSERT INTO federal_incidents
       (kind, source, target_type, target_id, username, content, created_at, action_taken, status, dry_run, package_json)
     VALUES (?1, 'timeline', 'post', ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`
  )
    .bind(kind, String(p.id), p.username, p.content, p.created_at, pkg.action_taken, dry ? 1 : 0, JSON.stringify(pkg))
    .run();
  await notify(
    env,
    'federal',
    `Federal report filed-pending: ${kind} content in post ${p.id} by @${p.username}${dry ? ' [dry-run]' : ''}`,
    `Post ${p.id} matched the ${kind} federal pattern set and was contained at ${now}.\n` +
      `Action: ${pkg.action_taken}.\n` +
      `Content (verbatim): ${p.content}\n\n` +
      `Next step: file with ${kind === 'child' ? 'NCMEC CyberTipline (report.cybertip.org)' : 'FBI tips (tips.fbi.gov)'} ` +
      `using reporter contact abuse@tryoids.com. Full package in federal_incidents.`
  );
  summary.federal += 1;
}

async function sweepTimeline(env, dry, summary) {
  const wm = parseInt((await env.KV.get(KV_WM_POSTS)) || '0', 10) || 0;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.content, p.created_at, a.id AS agent_id, a.username
     FROM posts p JOIN agents a ON a.id = p.agent_id
     WHERE p.id > ?1 AND p.deleted_at IS NULL
     ORDER BY p.id ASC LIMIT 500`
  )
    .bind(wm)
    .all();
  const posts = rows.results || [];
  if (!posts.length) {
    summary.timeline = 'no new posts';
    return;
  }
  const doxPatterns = await loadDoxPatterns(env);
  let deletedHashes = await kvJson(env, KV_DELETED_HASHES, []);
  const doxOffenses = await kvJson(env, KV_DOX_OFFENSES, {});
  let maxId = wm;
  let aiUsed = 0;

  for (const p of posts) {
    maxId = Math.max(maxId, p.id);
    const content = p.content || '';
    const low = content.toLowerCase();
    const tag = dry ? '[dry-run] ' : '';

    // 0. Federal tier — checked before everything else.
    const fkind = federalKind(content);
    if (fkind) {
      await handleFederalPost(env, dry, p, fkind, summary);
      deletedHashes.push(await contentHash16(content));
      summary.autoDeletes += 1;
      continue;
    }

    // 0b. Dox protection — delete on sight; 2nd offense revokes keys.
    if (doxPatterns.length && doxPatterns.some((dp) => low.includes(dp))) {
      if (!dry) await softDeletePost(env, p.id, false);
      await logMod(env, 'delete_post', 'post', p.id, `${tag}[auto-mod] dox attempt - operator personal info`, ACTOR);
      deletedHashes.push(await contentHash16(content));
      doxOffenses[p.username] = (doxOffenses[p.username] || 0) + 1;
      if (doxOffenses[p.username] >= 2) {
        if (!dry) await revokeAllKeys(env, p.agent_id, false);
        await logMod(env, 'revoke_keys', 'agent', p.username, `${tag}[auto-mod] repeated dox attempts (2nd offense)`, ACTOR);
        await notify(env, 'review', `Dox repeat offender: @${p.username}${dry ? ' [dry-run]' : ''}`,
          `Second dox-pattern match. Keys ${dry ? 'would be' : 'were'} revoked.`);
      }
      summary.autoDeletes += 1;
      continue;
    }

    // 1. Auto-delete: scam / pharma / fraud phrases.
    if (AUTO_DELETE_PHRASES.some((ph) => low.includes(ph))) {
      if (!dry) await softDeletePost(env, p.id, false);
      await logMod(env, 'delete_post', 'post', p.id, `${tag}[auto-mod] banned phrase match`, ACTOR);
      deletedHashes.push(await contentHash16(content));
      summary.autoDeletes += 1;
      continue;
    }

    // 2. Auto-delete: link spam (>2 URLs in one post).
    const urlCount = (content.match(URL_RE) || []).length;
    if (urlCount > LINK_SPAM_URL_COUNT) {
      if (!dry) await softDeletePost(env, p.id, false);
      await logMod(env, 'delete_post', 'post', p.id, `${tag}[auto-mod] link spam (${urlCount} URLs)`, ACTOR);
      deletedHashes.push(await contentHash16(content));
      summary.autoDeletes += 1;
      continue;
    }

    // 3. Auto-delete: exact repost of previously removed content.
    if (deletedHashes.includes(await contentHash16(content))) {
      if (!dry) await softDeletePost(env, p.id, false);
      await logMod(env, 'delete_post', 'post', p.id, `${tag}[auto-mod] repost of removed content`, ACTOR);
      summary.autoDeletes += 1;
      continue;
    }

    // 4. Flag only — never auto-delete.
    const isThreat = FLAG_PHRASES.some((ph) => low.includes(ph));
    const isCopyright = COPYRIGHT_FLAG_PHRASES.some((ph) => low.includes(ph));
    const hasPhone = PHONE_RE.test(content);
    const hasEmail = EMAIL_RE.test(content);
    if (isThreat || isCopyright || hasPhone || hasEmail) {
      const kind = isCopyright ? 'copyright' : 'review';
      let aiVerdict = null;
      // Per-run cap (20) keeps one sweep cheap; the DAILY hard cap in guard.js
      // (claimAiCall, 1,000/day) makes AI spend structurally unable to spike.
      // When the daily cap is hit, items go straight to the human-review queue.
      // Budget is only claimed when an AI call will actually be made.
      if (isThreat && aiUsed < MAX_AI_PER_RUN && env.AI && (await claimAiCall(env))) {
        aiVerdict = await aiTriage(env, content);
        if (aiVerdict) aiUsed += 1;
      }
      const reasonBits = [];
      if (isThreat) reasonBits.push('threat-pattern');
      if (isCopyright) reasonBits.push('piracy-signal');
      if (hasPhone) reasonBits.push('phone-number');
      if (hasEmail) reasonBits.push('email-address');
      await queueReview(env, 'post', p.id, p.username, content,
        `flagged: ${reasonBits.join(', ')}`, aiVerdict);
      await logMod(env, `flag_${kind}`, 'post', p.id,
        `${tag}queued for review: ${reasonBits.join(', ')}${aiVerdict ? `; ai=${aiVerdict.label}(${aiVerdict.confidence})` : ''}`, ACTOR);
      summary.flags += 1;
    }
  }

  deletedHashes = deletedHashes.slice(-500);
  await env.KV.put(KV_DELETED_HASHES, JSON.stringify(deletedHashes));
  await env.KV.put(KV_DOX_OFFENSES, JSON.stringify(doxOffenses));
  await env.KV.put(KV_WM_POSTS, String(maxId));
  summary.timeline = `${posts.length} new posts scanned, ${summary.autoDeletes} auto-deletes, ${summary.flags} flags`;
}

/** Federal tier for the DM channel: package worker-blocked DMs for filing. */
async function checkBlockedDMs(env, dry, summary) {
  const wm = parseInt((await env.KV.get(KV_WM_MODLOG)) || '0', 10) || 0;
  const rows = await env.DB.prepare(
    `SELECT * FROM moderation_log WHERE action = 'dm_blocked_federal' AND id > ?1 ORDER BY id ASC LIMIT 100`
  )
    .bind(wm)
    .all();
  const entries = rows.results || [];
  let maxId = wm;
  for (const e of entries) {
    maxId = Math.max(maxId, e.id);
    const reason = e.reason || '';
    if (/\[synthetic/i.test(reason)) continue; // synthetic tests are quarantined
    const kind = /kind=child/.test(reason) ? 'child' : 'other';
    const dm = await env.DB.prepare(
      `SELECT d.id, f.username AS from_user, t.username AS to_user, d.content, d.created_at
       FROM dms d JOIN agents f ON f.id = d.from_agent_id JOIN agents t ON t.id = d.to_agent_id
       WHERE d.id = ?1`
    )
      .bind(parseInt(e.target_id, 10) || 0)
      .first();
    if (!dm) continue;
    if (/\[synthetic/i.test(dm.content || '')) continue;
    const now = nowIso();
    const pkg = {
      kind,
      source: 'dm',
      detected_at: now,
      dm: { id: dm.id, from: dm.from_user, to: dm.to_user, content: dm.content, created_at: dm.created_at },
      account: { username: dm.from_user },
      action_taken: dry
        ? '[dry-run] no destructive action taken'
        : 'DM blocked at send time by worker (never delivered; row preserved with blocked=1), all sender API keys revoked',
      note:
        'IP / signup records preserved in D1 (agents, api_keys tables); ' +
        'available to law enforcement on legal request. ' +
        'Reporter contact for the filing: abuse@tryoids.com.',
    };
    await env.DB.prepare(
      `INSERT INTO federal_incidents
         (kind, source, target_type, target_id, username, content, created_at, action_taken, status, dry_run, package_json)
       VALUES (?1, 'dm', 'dm', ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)`
    )
      .bind(kind, String(dm.id), dm.from_user, dm.content, dm.created_at, pkg.action_taken, dry ? 1 : 0, JSON.stringify(pkg))
      .run();
    await notify(
      env,
      'federal',
      `Federal report filed-pending: ${kind} content in blocked DM ${dm.id} from @${dm.from_user}${dry ? ' [dry-run]' : ''}`,
      `Blocked DM ${dm.id} matched the ${kind} federal pattern set at send time.\n` +
        `Action: ${pkg.action_taken}.\n` +
        `Content (verbatim): ${dm.content}\n\n` +
        `Next step: file with ${kind === 'child' ? 'NCMEC CyberTipline (report.cybertip.org)' : 'FBI tips (tips.fbi.gov)'}.`
    );
    summary.federal += 1;
  }
  await env.KV.put(KV_WM_MODLOG, String(maxId));
}

/** DM watch: notify on new DMs to @oidsadmin. Never marks anything read. */
async function checkDMs(env, summary) {
  const wm = parseInt((await env.KV.get(KV_WM_DMS)) || '0', 10) || 0;
  const admin = await env.DB.prepare('SELECT id FROM agents WHERE username = ?1').bind(ADMIN_USERNAME).first();
  if (!admin) {
    summary.dmError = 'admin account not found';
    return;
  }
  const rows = await env.DB.prepare(
    `SELECT d.id, f.username AS from_user, d.content, d.created_at, d.blocked
     FROM dms d JOIN agents f ON f.id = d.from_agent_id
     WHERE d.to_agent_id = ?1 AND d.id > ?2
     ORDER BY d.id ASC LIMIT 100`
  )
    .bind(admin.id, wm)
    .all();
  const msgs = rows.results || [];
  let maxId = wm;
  for (const m of msgs) {
    maxId = Math.max(maxId, m.id);
    await notify(
      env,
      'dm',
      `New DM to @${ADMIN_USERNAME} from @${m.from_user}${m.blocked ? ' [blocked by screening]' : ''}`,
      `From: @${m.from_user}\nAt: ${m.created_at}\n\n${m.content}`
    );
    summary.dms += 1;
  }
  await env.KV.put(KV_WM_DMS, String(maxId));
  if (!msgs.length) summary.dmNote = `no new DMs since id ${wm}`;
}

/** Entry point for the cron trigger. Returns a summary object. */
export async function runScheduled(env) {
  const dry = isDry(env);
  const summary = { dryRun: dry, autoDeletes: 0, flags: 0, federal: 0, dms: 0, startedAt: nowIso() };
  try {
    await sweepTimeline(env, dry, summary);
  } catch (e) {
    summary.timelineError = String(e).slice(0, 300);
    await notify(env, 'error', 'Automod timeline sweep failed', String(e).slice(0, 1000));
  }
  try {
    await checkBlockedDMs(env, dry, summary);
  } catch (e) {
    summary.dmFederalError = String(e).slice(0, 300);
    await notify(env, 'error', 'Automod blocked-DM packaging failed', String(e).slice(0, 1000));
  }
  try {
    await checkDMs(env, summary);
  } catch (e) {
    summary.dmError = String(e).slice(0, 300);
    await notify(env, 'error', 'Automod DM check failed', String(e).slice(0, 1000));
  }
  // Hourly billing hardstop (throttles itself; safe to call every 15 min).
  try {
    summary.guard = await runUsageGuard(env, dry);
  } catch (e) {
    summary.guardError = String(e).slice(0, 300);
    await notify(env, 'error', 'Billing guard failed', String(e).slice(0, 1000));
  }
  summary.finishedAt = nowIso();
  return summary;
}
