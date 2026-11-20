#!/usr/bin/env python3
"""
10K Takes: Instagram views and engagement collector (main account).

Saves two rows to metrics.csv (date,account,platform,metric,value):
  views_7d         Instagram "views" over the last 7 days (the replacement for
                   the retired "impressions" metric)
  engagements_7d   total interactions over the last 7 days (likes, comments,
                   saves, shares and replies)

Needs INSTAGRAM_ACCOUNT_ID and FACEBOOK_PAGE_TOKEN (same secrets as the
follower script). The token must carry instagram_manage_insights.
Standard library only.
"""
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

GRAPH_VERSION = "v26.0"
ACCOUNT = "10K Takes"
PLATFORM = "Instagram"
OUT = "metrics.csv"
HEADER = ["date", "account", "platform", "metric", "value"]
METRICS = {"views_7d": "views", "engagements_7d": "total_interactions"}
RATE_LIMIT_RETRIES = 3


def week_total(ig_id, token, metric):
    until = int(time.time())
    since = until - 7 * 86400
    url = "https://graph.facebook.com/{}/{}/insights?".format(GRAPH_VERSION, ig_id) + \
        urllib.parse.urlencode({"metric": metric, "metric_type": "total_value",
                                "period": "day", "since": since, "until": until})
    data = None
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.load(r)
            break
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429 and attempt < RATE_LIMIT_RETRIES:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    delay = max(1, int(retry_after)) if retry_after else 5 * (2 ** attempt)
                except ValueError:
                    delay = 5 * (2 ** attempt)
                print("::warning::{} was rate limited (HTTP 429); retry {}/{} in {} seconds.".format(
                    metric, attempt + 1, RATE_LIMIT_RETRIES, delay))
                time.sleep(delay)
                continue
            raise RuntimeError("{} error {}: {}".format(metric, e.code, body))
        except urllib.error.URLError as e:
            raise RuntimeError("{} unreachable: {}".format(metric, e.reason))
    for item in data.get("data", []):
        if item.get("name") == metric:
            if "total_value" in item:
                return int(item["total_value"].get("value", 0))
            return sum(int(v.get("value", 0)) for v in item.get("values", []))
    raise RuntimeError("{} returned no data: {}".format(metric, json.dumps(data)[:200]))


def save(new_rows):
    rows = []
    if os.path.exists(OUT):
        with open(OUT, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.reader(f) if r and r != HEADER]
    keys = {tuple(r[:4]) for r in new_rows}
    rows = [r for r in rows if tuple(r[:4]) not in keys] + new_rows
    rows.sort(key=lambda r: (r[0], r[1], r[2], r[3]))
    with open(OUT, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)


def main():
    ig_id = os.environ.get("INSTAGRAM_ACCOUNT_ID", "").strip()
    token = os.environ.get("FACEBOOK_PAGE_TOKEN", "").strip()
    if not ig_id or not token:
        sys.exit("Set INSTAGRAM_ACCOUNT_ID and FACEBOOK_PAGE_TOKEN first.")
    today, rows, failed = date.today().isoformat(), [], []
    for name, metric in METRICS.items():
        try:
            value = week_total(ig_id, token, metric)
        except RuntimeError as e:
            failed.append(name)
            print("::warning::{}".format(e))
            continue
        rows.append([today, ACCOUNT, PLATFORM, name, str(value)])
        print("{} | {} | {} | {}={:,}".format(today, ACCOUNT, PLATFORM, name, value))
    if rows:
        save(rows)
    if failed:
        sys.exit("Not saved: " + ", ".join(failed))


if __name__ == "__main__":
    main()
