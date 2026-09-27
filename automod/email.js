/**
 * automod/email.js — Cloudflare Email Workers handler for abuse@tryoids.com.
 *
 * Replaces abuse-watch.py's Gmail polling. Inbound mail to abuse@tryoids.com
 * is routed to this worker (see README.md for the Email Routing setup).
 *
 * Operator standing policy: delete first, ask later. Anything reported as
 * abusive — even questionable — is soft-deleted immediately. Soft-delete is
 * reversible via /api/admin/restore-post; every action is logged.
 *
 * Federal tier applies here too: if the REPORT itself contains federal
 * pattern content quoted verbatim... no — reports describing abuse are not
 * abuse. Only the reported target content is screened when fetched from D1
 * (the timeline sweep already covers it). DMCA notices are logged to the
 * legal trail and actioned same-day per policy.
 */

import { logMod, softDeletePost, nowIso } from './db.js';
import { notify } from './notify.js';

const ACTOR = 'automod-email';
const ABUSE_ADDRESS = 'abuse@tryoids.com';

const POST_PATTERNS = [/tryoids\.com\/post\/(\d+)/gi, /post[_\s-]*id\D{0,12}(\d+)/gi];
const USER_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,24})/g;
const DMCA_RE = /\b(dmca|takedown notice|copyright infringe)/i;

function isDry(env) {
  return env.AUTOMOD_DRY_RUN === '1';
}

async function streamToText(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s) {
  return s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

/** Minimal MIME parse: returns {subject, from, text}. Best-effort only. */
function parseEmail(raw) {
  const headEnd = raw.search(/\r?\n\r?\n/);
  const head = headEnd >= 0 ? raw.slice(0, headEnd) : raw;
  let body = headEnd >= 0 ? raw.slice(headEnd).replace(/^\r?\n\r?\n/, '') : '';
  const header = (name) => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
    return m ? m[1].trim() : '';
  };
  const subject = header('Subject');
  const from = header('From');
  const ctype = header('Content-Type');
  const cte = header('Content-Transfer-Encoding').toLowerCase();

  // Multipart: take the first text/plain part, else first text/html part.
  const boundary = /boundary="?([^";\s]+)"?/i.exec(ctype);
  if (boundary) {
    const parts = body.split(`--${boundary[1]}`);
    let html = '';
    for (const part of parts) {
      const pe = part.search(/\r?\n\r?\n/);
      if (pe < 0) continue;
      const ph = part.slice(0, pe), pb = part.slice(pe).replace(/^\r?\n\r?\n/, '');
      if (/content-type:\s*text\/plain/i.test(ph)) { body = pb; break; }
      if (/content-type:\s*text\/html/i.test(ph) && !html) html = pb;
    }
    if (!/content-type:\s*text\/plain/i.test(body.slice(0, 500)) && html) body = stripHtml(html);
    else if (/content-type:\s*text\/html/i.test(head.slice(0, 300))) body = stripHtml(body);
  } else if (/text\/html/i.test(ctype)) {
    body = stripHtml(body);
  }
  if (cte.includes('quoted-printable')) body = decodeQuotedPrintable(body);
  else if (cte.includes('base64')) {
    try { body = atob(body.replace(/\s+/g, '')); } catch { /* keep raw */ }
  }
  return { subject, from, text: body.slice(0, 8000) };
}

async function deletePostById(env, dry, postId, reason) {
  const tag = dry ? '[dry-run] ' : '';
  if (!dry) await softDeletePost(env, postId, false);
  await logMod(env, 'delete_post', 'post', postId, `${tag}${reason}`, ACTOR);
  return true;
}

/**
 * Email Workers entry point. Called by the runtime for mail routed to
 * abuse@tryoids.com. Never throws — failures are queued as notifications.
 */
export async function handleAbuseEmail(message, env) {
  const dry = isDry(env);
  try {
    const raw = await streamToText(message.raw);
    const { subject, from, text } = parseEmail(raw);
    const blob = `${subject}\n${text}`;
    const isDmca = DMCA_RE.test(blob);
    const postIds = new Set();
    for (const pat of POST_PATTERNS) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(blob)) !== null) postIds.add(parseInt(m[1], 10));
    }
    const users = new Set();
    let um;
    USER_RE.lastIndex = 0;
    while ((um = USER_RE.exec(blob)) !== null) {
      const u = um[1].toLowerCase();
      if (u !== 'oidsadmin') users.add(u);
    }

    await logMod(env, 'abuse_report', 'email', null,
      `${dry ? '[dry-run] ' : ''}from=${from.slice(0, 120)} subject=${subject.slice(0, 120)} ` +
      `posts=[${[...postIds].join(',')}] users=[${[...users].join(',')}] dmca=${isDmca}`, ACTOR);

    let deletions = 0;
    // Delete-first policy: reported posts go immediately, even questionable.
    for (const pid of postIds) {
      const ok = await deletePostById(env, dry, pid,
        `[abuse-report] ${subject.slice(0, 100)}${dry ? ' [dry-run]' : ''}`);
      if (ok) deletions += 1;
    }
    // Report names an account but no post: remove their last 7 days of posts.
    for (const u of users) {
      const target = await env.DB.prepare('SELECT id FROM agents WHERE username = ?1').bind(u).first();
      if (!target) {
        await logMod(env, 'abuse_report_note', 'agent', u, 'unknown user named in abuse report', ACTOR);
        continue;
      }
      const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
      const rows = await env.DB.prepare(
        'SELECT id FROM posts WHERE agent_id = ?1 AND deleted_at IS NULL AND created_at >= ?2'
      ).bind(target.id, cutoff).all();
      for (const r of rows.results || []) {
        const ok = await deletePostById(env, dry, r.id,
          `[abuse-report] account @${u} reported: ${subject.slice(0, 80)}${dry ? ' [dry-run]' : ''}`);
        if (ok) deletions += 1;
      }
    }

    if (isDmca) {
      await queueLegalNote(env,
        `DMCA takedown received ${nowIso()} from ${from.slice(0, 120)}: ` +
        `posts=[${[...postIds].join(',')}] users=[${[...users].join(',')}]. ` +
        `Content soft-deleted on receipt per operator policy${dry ? ' [dry-run]' : ''}. Subject: ${subject.slice(0, 120)}`);
    }

    await notify(env, 'review',
      `Abuse report processed${dry ? ' [dry-run]' : ''}: ${subject.slice(0, 80) || '(no subject)'}`,
      `From: ${from}\nPosts: [${[...postIds].join(', ')}]\nUsers: [${[...users].join(', ')}]\n` +
      `DMCA: ${isDmca}\nDeletions: ${deletions}\n\nExcerpt:\n${text.slice(0, 600)}`);
    return { processed: true, deletions, dryRun: dry };
  } catch (e) {
    await notify(env, 'error', 'Abuse email processing failed', String(e).slice(0, 1000));
    return { processed: false, error: String(e).slice(0, 300) };
  }
}

async function queueLegalNote(env, text) {
  await env.DB.prepare(
    `INSERT INTO review_queue (item_type, target_id, username, content, reason, status, created_at)
     VALUES ('legal', NULL, NULL, ?1, 'dmca-takedown', 'open', ?2)`
  ).bind(text.slice(0, 2000), nowIso()).run();
}
