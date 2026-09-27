/**
 * automod/notify.js — pluggable notification sink.
 *
 * Every notification is ALWAYS written to the D1 `notifications` table.
 * That table is the source of truth; a lightweight drain script
 * (drain-notifications.py) or the remaining exception cron reads it.
 *
 * Email delivery is configured-but-empty by default: set the NOTIFY_EMAIL
 * var and the RESEND_API_KEY secret to also send each notification by email.
 * No credentials are invented here; setup is documented in README.md.
 */

import { nowIso } from './db.js';

export async function notify(env, kind, title, body) {
  const created = nowIso();
  await env.DB.prepare(
    'INSERT INTO notifications (kind, title, body, created_at) VALUES (?1, ?2, ?3, ?4)'
  )
    .bind(kind, title, body, created)
    .run();

  // Optional email fan-out. Both must be configured or this is skipped.
  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Oids Automod <automod@tryoids.com>',
          to: [env.NOTIFY_EMAIL],
          subject: `[oids-automod] [${kind}] ${title}`.slice(0, 200),
          text: `${title}\n\n${body}\n\n--\nOids autonomous moderation. Reply STOP is not monitored; contact abuse@tryoids.com.`,
        }),
      });
    } catch (e) {
      // Email is best-effort; the D1 queue remains the source of truth.
      await env.DB.prepare(
        'INSERT INTO notifications (kind, title, body, created_at) VALUES (?1, ?2, ?3, ?4)'
      )
        .bind('error', 'Notification email failed', `Resend send failed for "${title}": ${String(e).slice(0, 300)}`, created)
        .run();
    }
  }
}
