#!/usr/bin/env python3
"""
10K Takes: X/Twitter follower collector (all six accounts).

Looks up every account in one request through the X API v2 and saves one dated
row per account to followers.csv:  date,account,platform,followers

Needs one environment variable (stored as a GitHub secret):
  X_BEARER_TOKEN   the app's Bearer Token from the X Developer Console

Edit HANDLES below: the left side is the X handle (no @), the right side must
match the account name the dashboard uses.

Uses only the Python standard library.
"""
import csv
import json
import os
import sys
import argparse
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

HANDLES = {
    "10K_Takes": "10K Takes",
    "WildTakes10k": "Wild Takes",
    "10kHowls": "10K Howls",
    "StateofSkol10k": "State of Skol",
    "TheUnderline10K": "The Underline",
    "Captains_Patch": "Captain's Patch",
}
PLATFORM = "X/Twitter"
OUTPUT_FILE = "followers.csv"
HEADER = ["date", "account", "platform", "followers"]


def fetch_followers(token, handles):
    names = ",".join(handles)
    url = "https://api.x.com/2/users/by?" + urllib.parse.urlencode(
        {"usernames": names, "user.fields": "public_metrics"})
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        hint = " (402 usually means the account is out of credits)" if e.code == 402 else ""
        sys.exit("X API error {}{}: {}".format(e.code, hint, body))
    except urllib.error.URLError as e:
        sys.exit("Could not reach X: {}".format(e.reason))
    found = {}
    for u in data.get("data", []):
        found[u["username"].lower()] = u["public_metrics"]["followers_count"]
    return found, data.get("errors", [])


def save_rows(new_rows):
    rows = []
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.reader(f) if r and r != HEADER]
    keys = {tuple(r[:3]) for r in new_rows}
    rows = [r for r in rows if tuple(r[:3]) not in keys] + new_rows
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Collect X follower counts.")
    parser.add_argument("--main-account-only", action="store_true",
                         help="Collect 10K Takes only; subsidiaries remain on the weekly run.")
    args = parser.parse_args()
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not token:
        sys.exit("Set the X_BEARER_TOKEN environment variable first.")
    if any(h.startswith("REPLACE_") for h in HANDLES):
        sys.exit("Edit HANDLES in collect_x.py and enter the real X handles first.")
    handles = {"10K_Takes": HANDLES["10K_Takes"]} if args.main_account_only else HANDLES
    found, errors = fetch_followers(token, handles)
    today = date.today().isoformat()
    new_rows, missing = [], []
    for handle, account in handles.items():
        count = found.get(handle.lower())
        if count is None:
            missing.append(handle)
            continue
        new_rows.append([today, account, PLATFORM, str(count)])
        print("{} | {} | {} (@{}) | {:,}".format(today, account, PLATFORM, handle, count))
    if new_rows:
        save_rows(new_rows)
    if missing:
        sys.exit("No data for: {}. Check the spelling, or whether they are suspended. {}".format(
            ", ".join(missing), json.dumps(errors)[:300]))


if __name__ == "__main__":
    main()
