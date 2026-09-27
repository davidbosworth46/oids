#!/usr/bin/env python3
"""Drain the automod notification queue.

Reads undelivered rows from the D1 `notifications` table (written by the
scheduled automod worker), prints them for the operator, and marks them
delivered. This is the lightweight "exception cron" body: run every 30-60
minutes. Quiet when empty.

Usage: python3 drain-notifications.py [--limit N] [--no-mark]
"""
import json, os, subprocess, sys

HOME = os.path.expanduser("~")
TOKEN_FILE = os.path.join(HOME, ".cloudflare", "api-token")
OIDSDIR = os.path.join(HOME, "workspace", "oids")


def d1(sql):
    tok = open(TOKEN_FILE).read().strip()
    env = dict(os.environ, CLOUDFLARE_API_TOKEN=tok)
    p = subprocess.run(
        ["npx", "-y", "wrangler", "d1", "execute", "oids-db", "--remote",
         "--command", sql, "--json"],
        capture_output=True, text=True, cwd=OIDSDIR, env=env, timeout=120)
    if p.returncode != 0:
        print("D1_ERROR: " + (p.stderr or p.stdout)[-500:], file=sys.stderr)
        sys.exit(2)
    out = []
    for b in json.loads(p.stdout):
        out.extend(b.get("results", []))
    return out


def main():
    limit = 50
    mark = True
    for a in sys.argv[1:]:
        if a.startswith("--limit"):
            limit = int(a.split("=")[1])
        if a == "--no-mark":
            mark = False
    rows = d1(
        "SELECT id, kind, title, body, created_at FROM notifications "
        f"WHERE delivered = 0 ORDER BY id ASC LIMIT {limit};")
    if not rows:
        print("NOTIFY_QUIET: no undelivered notifications")
        return 0
    for r in rows:
        print(f"=== [{r['kind']}] {r['title']} (id={r['id']}, {r['created_at']}) ===")
        print(r["body"])
        print()
    if mark:
        ids = ",".join(str(r["id"]) for r in rows)
        d1(f"UPDATE notifications SET delivered = 1, delivered_at = "
           f"strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN ({ids});")
        print(f"marked {len(rows)} delivered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
