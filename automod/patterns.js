/**
 * automod/patterns.js — canonical moderation pattern sets for Oids.
 *
 * Single source of truth. Used by:
 *   - worker/index.js  (send-time DM safety screening)
 *   - automod/sweep.js (scheduled timeline sweep)
 *
 * Ported from mod-sweep.py; the regexes are character-identical to the ones
 * previously inline in worker/index.js, so replacing them with this import
 * changes no behavior.
 *
 * PRIVACY: operator personal identifiers (dox patterns) are NEVER stored here.
 * They live in KV under `automod:dox-patterns`, seeded by the operator from
 * the private local file at cutover. See README.md.
 */

// --- FEDERAL-REPORT tier: child sexual exploitation + other clearly illegal
// content. Text-pattern screening only. A match means: contain immediately
// (soft-delete / block), revoke keys, preserve evidence, package for filing.
export const FEDERAL_CHILD_RES = [
  /child\s*porn/i, /childporn/i, /\bcp\s*trade\b/i, /trading\s*cp\b/i,
  /\bcp\s*drop\b/i, /\bloli\b/i, /\bshota\b/i, /\bjailbait\b/i, /\bpedo\b/i,
  /preteen\s*(porn|sex|nude|pics?)/i, /kid\s*(porn|sex\s*tape)/i,
  /minor\s*(porn|sex\s*tape|nudes?)/i, /teen\s*(porn\s*trade|sex\s*trade)/i,
];
export const FEDERAL_OTHER_RES = [
  /hire\s*a\s*hitman/i, /hitman\s*for\s*hire/i, /murder\s*for\s*hire/i,
  /kill\s*for\s*cash/i, /pay.*to\s*kill\s*someone/i,
];

/** Returns 'child' | 'other' | null. Child patterns are checked first. */
export function federalKind(s) {
  if (FEDERAL_CHILD_RES.some((r) => r.test(s))) return 'child';
  if (FEDERAL_OTHER_RES.some((r) => r.test(s))) return 'other';
  return null;
}

// --- high-confidence auto-delete: scam / pharma / fraud phrases ---
export const AUTO_DELETE_PHRASES = [
  'viagra', 'cialis', 'send 1 eth', 'send eth', 'double your crypto',
  'crypto giveaway', 'free nft mint', 'claim your airdrop',
  'work from home $$$', 'make $5000', 'password is', 'ssn:',
];

// --- flag for human review (never auto-delete) ---
export const FLAG_PHRASES = [
  'kill yourself', 'kys', 'i will kill', 'bomb threat',
];

// --- copyright: piracy signals are review-only (fair use is gray area) ---
export const COPYRIGHT_FLAG_PHRASES = [
  'free download', 'download full', 'cracked apk', 'cracked app',
  'torrent download', 'magnet:?', 'pirated', 'leaked pdf',
  'full movie free', 'watch free no signup',
];

export const URL_RE = /https?:\/\//gi;
export const PHONE_RE = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/;
export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Link spam threshold: more than this many URLs in one post.
export const LINK_SPAM_URL_COUNT = 2;

/** Load operator dox patterns from KV. Returns [] when not configured. */
export async function loadDoxPatterns(env) {
  try {
    const raw = await env.KV.get('automod:dox-patterns');
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((s) => String(s).toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
