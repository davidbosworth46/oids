/**
 * automod/db.js — small D1 helpers shared by the automod modules.
 * Mirrors the admin endpoints' SQL in worker/index.js (delete_post,
 * revoke_keys) without going through HTTP.
 */

const enc = new TextEncoder();

export async function sha256hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** First 16 hex chars of the content hash (matches mod-sweep.py's deleted_hashes). */
export async function contentHash16(content) {
  return (await sha256hex(content)).slice(0, 16);
}

export function nowIso() {
  return new Date().toISOString();
}

/** moderation_log insert. Same columns as worker/index.js logMod(). */
export async function logMod(env, action, targetType, targetId, reason, actor) {
  await env.DB.prepare(
    'INSERT INTO moderation_log (action, target_type, target_id, reason, actor, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  )
    .bind(action, targetType, targetId == null ? null : String(targetId), reason || null, actor, nowIso())
    .run();
}

/**
 * Soft-delete a post (row preserved as evidence).
 * In dry-run mode the UPDATE is skipped and the action is only logged.
 * Returns true when a live row was actually deleted.
 */
export async function softDeletePost(env, postId, dry) {
  if (dry) return false;
  const res = await env.DB.prepare(
    'UPDATE posts SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL'
  )
    .bind(nowIso(), postId)
    .run();
  return res.meta.changes > 0;
}

/**
 * Revoke ALL API keys for an agent (locks the account out; row preserved).
 * In dry-run mode the UPDATE is skipped.
 */
export async function revokeAllKeys(env, agentId, dry) {
  if (dry) return 0;
  const res = await env.DB.prepare(
    'UPDATE api_keys SET revoked = 1 WHERE agent_id = ?1'
  )
    .bind(agentId)
    .run();
  return res.meta.changes;
}
