#!/usr/bin/env python3
"""Send the existing top_posts.csv snapshot to the Content Intelligence Worker."""

import csv
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import date


def main():
    base_url = os.environ.get("CONTENT_INTELLIGENCE_API_URL", "").strip().rstrip("/")
    token = os.environ.get("CONTENT_INTELLIGENCE_TOKEN", "").strip()
    if not base_url or not token:
        sys.exit("CONTENT_INTELLIGENCE_API_URL and CONTENT_INTELLIGENCE_TOKEN are required")

    items = []
    with open("top_posts.csv", newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("url") or not row.get("platform") or not row.get("posted"):
                continue
            item = {
                "snapshot_date": row.get("snapshot") or date.today().isoformat(),
                "platform": row["platform"].strip(),
                "url": row["url"].strip(),
                "posted_at": row["posted"].strip(),
                "format": (row.get("type") or "Post").strip(),
                "caption": (row.get("caption") or "")[:280],
            }
            for field in ("views", "likes", "comments", "shares", "saves"):
                value = (row.get(field) or "").strip()
                try:
                    item[field] = max(0, int(value)) if value else None
                except ValueError:
                    item[field] = None
            items.append(item)

    if not items:
        sys.exit("top_posts.csv contained no importable post rows")

    payload = json.dumps({"items": items}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        base_url + "/v1/import",
        data=payload,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "User-Agent": "10K-Takes-Content-Intelligence/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as result:
            body = json.loads(result.read().decode("utf-8"))
            print("Content Intelligence import complete: {} row(s), {} recommendation(s).".format(
                body.get("items_imported", 0), body.get("recommendations_created", 0)
            ))
    except urllib.error.HTTPError as error:
        # Never print headers or the request object; it contains the bearer secret.
        detail = error.read().decode("utf-8", "replace")[:300]
        sys.exit("Content Intelligence Worker returned HTTP {}: {}".format(error.code, detail))
    except urllib.error.URLError as error:
        sys.exit("Could not reach Content Intelligence Worker: {}".format(error.reason))


if __name__ == "__main__":
    main()
