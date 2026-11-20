#!/usr/bin/env python3
"""
10K Takes: Facebook followers, views and engagement for the SUBSIDIARY Pages.

For each Page in PAGES (account name -> Facebook Page ID) it saves:
  followers.csv  date,account,platform,followers
  metrics.csv    date,account,platform,metric,value   (views_7d, engagements_7d)

Needs one secret: FACEBOOK_SYSTEM_USER_TOKEN, the non-expiring token of the
follower-bot system user, which must have each Page assigned to it. The script
trades it for each Page's own token at run time, so you do not store a token
per Page. Pages whose ID is still a REPLACE_ placeholder are skipped.

  python3 collect_facebook_subsidiaries.py --list
      prints the id and name of every Page the token can see (no tokens).
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

GRAPH = "v26.0"
PLATFORM = "Facebook"
PAGES = {
    "Wild Takes": "786488311204090",
    "10K Howls": "715792751615461",
    "State of Skol": "685113294691308",
    "The Underline": "731052936753599",
    "Captain's Patch": "1444449392073981",
}
METRICS = {"views_7d": "page_media_view", "engagements_7d": "page_post_engagements"}
RATE_LIMIT_RETRIES = 3
FOLLOWERS_FILE, FHEADER = "followers.csv", ["date", "account", "platform", "followers"]
METRICS_FILE, MHEADER = "metrics.csv", ["date", "account", "platform", "metric", "value"]


def get(path, params, token):
    url = "https://graph.facebook.com/{}/{}?".format(GRAPH, path) + urllib.parse.urlencode(params)
    for attempt in range(RATE_LIMIT_RETRIES + 1):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 429 and attempt < RATE_LIMIT_RETRIES:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                try:
                    delay = max(1, int(retry_after)) if retry_after else 5 * (2 ** attempt)
                except ValueError:
                    delay = 5 * (2 ** attempt)
                print("::warning::Facebook API rate limit on {}; retry {}/{} in {} seconds.".format(
                    path, attempt + 1, RATE_LIMIT_RETRIES, delay))
                time.sleep(delay)
                continue
            raise RuntimeError("Facebook error {}: {}".format(e.code, body.replace(token, "***")))
        except urllib.error.URLError as e:
            raise RuntimeError("Could not reach Facebook: {}".format(e.reason))


def week_total(page_id, page_token, metric):
    until = int(time.time())
    data = get(page_id + "/insights", {"metric": metric, "period": "day",
                                       "since": until - 7 * 86400, "until": until}, page_token)
    for item in data.get("data", []):
        if item.get("name") == metric:
            return sum(int(v["value"]) for v in item.get("values", [])
                       if isinstance(v.get("value"), (int, float)))
    raise RuntimeError("{} returned no data".format(metric))


def merge(path, header, new_rows, keylen):
    rows = []
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.reader(f) if r and r != header]
    keys = {tuple(r[:keylen]) for r in new_rows}
    rows = [r for r in rows if tuple(r[:keylen]) not in keys] + new_rows
    rows.sort(key=lambda r: tuple(r[:keylen + 1]))
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    token = os.environ.get("FACEBOOK_SYSTEM_USER_TOKEN", "").strip()
    if not token:
        sys.exit("Set FACEBOOK_SYSTEM_USER_TOKEN first.")
    if "--list" in sys.argv:
        for p in get("me/accounts", {"fields": "id,name", "limit": 100}, token).get("data", []):
            print(p["id"], p["name"])
        return
    today, frows, mrows, failed = date.today().isoformat(), [], [], []
    for account, page_id in PAGES.items():
        if page_id.startswith("REPLACE_"):
            print("Skipping {} (no Page ID yet)".format(account))
            continue
        try:
            page_token = get(page_id, {"fields": "access_token"}, token)["access_token"]
            info = get(page_id, {"fields": "followers_count,fan_count"}, page_token)
            count = info.get("followers_count", info.get("fan_count"))
            if count is None:
                raise RuntimeError("no follower count returned")
        except (RuntimeError, KeyError) as e:
            failed.append(account)
            print("::error::{}: {}".format(account, e))
            continue
        frows.append([today, account, PLATFORM, str(int(count))])
        line = "{} | {} | {} | followers={:,}".format(today, account, PLATFORM, int(count))
        for name, metric in METRICS.items():
            try:
                v = week_total(page_id, page_token, metric)
                mrows.append([today, account, PLATFORM, name, str(v)])
                line += " {}={:,}".format(name, v)
            except RuntimeError as e:
                print("::warning::{} {}: {}".format(account, name, e))
        print(line)
    if frows:
        merge(FOLLOWERS_FILE, FHEADER, frows, 3)
    if mrows:
        merge(METRICS_FILE, MHEADER, mrows, 4)
    if failed:
        sys.exit("Failed: " + ", ".join(failed))


if __name__ == "__main__":
    main()
