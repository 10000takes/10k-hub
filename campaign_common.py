"""Shared helpers for the sponsored-post (campaign) collectors. Standard library only."""
import csv
import os
import re
from datetime import date, timedelta

POSTS_FILE = "posts.csv"
METRICS_FILE = "post_metrics.csv"
MHEADER = ["date", "url", "metric", "value"]
ALIASES = {"x": "X/Twitter", "twitter": "X/Twitter", "x/twitter": "X/Twitter", "youtube": "YouTube",
           "instagram": "Instagram", "tiktok": "TikTok", "threads": "Threads", "facebook": "Facebook"}


def norm_url(u):
    """Same rule the dashboard uses, so rows match: no query/fragment, no www, no trailing slash."""
    u = (u or "").strip()
    yt = re.match(r"^https?://(?:www\.|m\.)?youtube\.com/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})", u, flags=re.I)
    if yt:  # for YouTube watch links the video id lives in the query string
        return "https://youtube.com/watch?v=" + yt.group(1)
    u = re.sub(r"[?#].*$", "", u)
    u = re.sub(r"^https?://(www\.|m\.)?", "https://", u, flags=re.I)
    return u.rstrip("/")


def env_name(prefix, account):
    """THREADS_ACCESS_TOKEN_ + account name, e.g. Captain's Patch -> CAPTAINS_PATCH."""
    return prefix + re.sub(r"[^A-Z0-9]+", "_", account.upper().replace("'", "")).strip("_")


def read_posts(platform=None, account=None, max_age_days=35):
    """Posts from posts.csv published within max_age_days (older months are frozen)."""
    if not os.path.exists(POSTS_FILE):
        return []
    out, cutoff = [], date.today() - timedelta(days=max_age_days)
    with open(POSTS_FILE, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            r = {k.strip().lower(): (v or "").strip() for k, v in r.items() if k}
            if not r.get("url"):
                continue
            r["platform"] = ALIASES.get(r.get("platform", "").lower(), r.get("platform", ""))
            try:
                posted = date.fromisoformat(r.get("posted", ""))
            except ValueError:
                continue
            if posted < cutoff:
                continue
            if platform and r["platform"] != platform:
                continue
            if account and r.get("account", "").casefold() != account.casefold():
                continue
            r["key"] = norm_url(r["url"])
            out.append(r)
    return out


def save_post_metrics(new_rows):
    """Merge [date,url,metric,value] rows into post_metrics.csv (same key replaces)."""
    rows = []
    if os.path.exists(METRICS_FILE):
        with open(METRICS_FILE, newline="", encoding="utf-8") as f:
            rows = [r for r in csv.reader(f) if r and r != MHEADER]
    keys = {tuple(r[:3]) for r in new_rows}
    rows = [r for r in rows if tuple(r[:3]) not in keys] + [list(map(str, r)) for r in new_rows]
    rows.sort(key=lambda r: (r[1], r[2], r[0]))
    with open(METRICS_FILE, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(MHEADER)
        w.writerows(rows)


def metric_rows(key, values):
    """values: dict like {"views": 10, "likes": 2}; None values are skipped."""
    today = date.today().isoformat()
    return [[today, key, m, int(v)] for m, v in values.items() if v is not None]
