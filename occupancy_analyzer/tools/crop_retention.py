#!/usr/bin/env python3
"""
Delete plate crops older than the retention window (14 days, plan doc 08 §4).

Storage objects must be removed through the Storage API (not SQL), so this
runs outside the database: it asks the DB which crops are due
(public.crops_due_for_deletion), deletes them from the private bucket, then
marks them deleted (public.mark_crops_deleted). Idempotent and safe to re-run.

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET (default event-snapshots)

    python occupancy_analyzer/tools/crop_retention.py [--days 14] [--dry-run]
"""

import argparse
import json
import os
import sys
import urllib.request


def call(method, url, key, body=None):
    req = urllib.request.Request(
        url, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    bucket = os.environ.get("SUPABASE_BUCKET", "event-snapshots")

    total = 0
    while True:
        due = call("POST", f"{base}/rest/v1/rpc/crops_due_for_deletion", key, {"p_days": args.days, "p_limit": 500})
        if not due:
            break
        paths = [d["image_path"] for d in due]
        if args.dry_run:
            print(f"would delete {len(paths)} crops, e.g. {paths[:3]}")
            break
        # bulk delete; missing objects are not an error
        call("DELETE", f"{base}/storage/v1/object/{bucket}", key, {"prefixes": paths})
        call("POST", f"{base}/rest/v1/rpc/mark_crops_deleted", key, {"p_ids": [d["read_id"] for d in due]})
        total += len(paths)
        print(f"deleted {len(paths)} crops")
    print(f"done: {total} crop(s) deleted")


if __name__ == "__main__":
    sys.exit(main())
