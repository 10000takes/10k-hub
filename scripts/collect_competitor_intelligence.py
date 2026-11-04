#!/usr/bin/env python3
"""Collect public Instagram Business Discovery data and derive competitor signals.

This collector is deliberately opt-in. It does not scrape social websites.
Instagram access requires an eligible 10K Takes professional account, a token
with the necessary Meta permissions, and eligible public Business/Creator targets.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "config" / "monitored_sources.json"
OUTPUT = ROOT / "competitor-intelligence.json"
GRAPH_VERSION = "v26.0"
POST_LIMIT = 15
HISTORY_DAYS = 14

TOPIC_TERMS = {
    "Vikings": ("vikings", "skol", "kevin o'connell", "j.j. mccarthy", "jj mccarthy"),
    "Twins": ("twins", "target field", "pablo lopez", "pablo lópez"),
    "Timberwolves": ("timberwolves", "timberwolves", "wolves", "anthony edwards", "ant edwards", "gobert"),
    "Lynx": ("lynx", "napheesa collier", "caitlin clark"),
    "Wild": ("wild", "kaprizov", "kirill", "hockey"),
    "Gophers": ("gophers", "minnesota football", "minnesota golden"),
    "Minnesota United": ("loons", "minnesota united", "mnu fc"),
    "Minnesota Frost": ("frost", "pwhl minnesota"),
}


def now_utc():
    return datetime.now(timezone.utc)


def parse_time(value):
    try:
        return datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except ValueError:
        return None


def graph_get(account_id, handle, token):
    username = handle.lstrip("@").strip()
    fields = (
        "business_discovery.username({}){{username,name,followers_count,media_count,"
        "media.limit({}){{id,caption,comments_count,like_count,media_type,"
        "media_product_type,permalink,timestamp}}}}"
    ).format(username, POST_LIMIT)
    url = "https://graph.facebook.com/{}/{}?{}".format(
        GRAPH_VERSION, account_id, urllib.parse.urlencode({"fields": fields}))
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("Meta API {} for {}: {}".format(error.code, handle, detail))
    except urllib.error.URLError as error:
        raise RuntimeError("Meta API unreachable for {}: {}".format(handle, error.reason))
    if payload.get("error"):
        raise RuntimeError("Meta API for {}: {}".format(handle, payload["error"].get("message", "unknown error")))
    return payload.get("business_discovery")


def post_format(media):
    if media.get("media_product_type") == "REELS":
        return "Reel"
    return {"CAROUSEL_ALBUM": "Carousel", "VIDEO": "Video", "IMAGE": "Image"}.get(media.get("media_type"), "Post")


def hook_style(caption):
    opening = re.sub(r"\s+", " ", (caption or "").strip().split("\n", 1)[0]).lower()
    if not opening:
        return "No caption hook"
    if "?" in opening or opening.startswith(("who ", "what ", "when ", "where ", "why ", "how ")):
        return "Question"
    if any(word in opening for word in ("breaking", "official", "report:", "just in")):
        return "News update"
    if any(phrase in opening for phrase in ("hot take", "unpopular opinion", "i think", "we think")):
        return "Opinion"
    if any(phrase in opening for phrase in ("me when", "pov:", "when you", "that feeling")):
        return "Relatable setup"
    if any(ch.isdigit() for ch in opening[:25]):
        return "Stat or list lead"
    return "Statement"


def topic_labels(caption):
    text = (caption or "").lower()
    found = [team for team, terms in TOPIC_TERMS.items() if any(term in text for term in terms)]
    hashtags = re.findall(r"(?<!\w)#[\w]+", text)
    return found[:3], list(dict.fromkeys(hashtags))[:8]


def interaction_count(post):
    values = [post.get("likes"), post.get("comments")]
    return sum(int(value) for value in values if value is not None)


def enrich_posts(accounts, previous, report_date):
    old_history = previous.get("post_history", {}) if isinstance(previous, dict) else {}
    history = {}
    posts = []
    for account in accounts:
        rows = account.pop("posts", [])
        follower_count = account.get("followers") or 0
        account_rates = [interaction_count(post) / follower_count for post in rows if follower_count]
        account_median = median(account_rates) if account_rates else None
        for post in rows:
            post_id = str(post["id"])
            snapshots = list(old_history.get(post_id, []))
            snapshots.append({"date": report_date, "likes": post.get("likes"), "comments": post.get("comments")})
            snapshots = [row for row in snapshots if row.get("date", "") >= report_date[:4] + "-01-01"][-HISTORY_DAYS:]
            history[post_id] = snapshots
            prior = next((row for row in reversed(snapshots[:-1]) if row.get("date") <= report_date), None)
            post["daily_interaction_change"] = None
            if prior and prior.get("likes") is not None and post.get("likes") is not None:
                post["daily_interaction_change"] = interaction_count(post) - int(prior.get("likes", 0) or 0) - int(prior.get("comments", 0) or 0)
            rate = interaction_count(post) / follower_count if follower_count else None
            post["engagement_rate_proxy"] = round(rate, 6) if rate is not None else None
            post["account_median_rate"] = round(account_median, 6) if account_median is not None else None
            post["relative_to_account_median"] = round(rate / account_median, 2) if rate is not None and account_median else None
            post["stronger_than_account_baseline"] = bool(
                len(account_rates) >= 5 and account_median and rate is not None and rate >= account_median * 1.5)
            topics, hashtags = topic_labels(post.get("caption"))
            post["topics"] = topics
            post["hashtags"] = hashtags
            posts.append(post)
    return posts, history


def make_recommendations(posts):
    buckets = defaultdict(list)
    for post in posts:
        if post["stronger_than_account_baseline"]:
            labels = post["topics"] or post["hashtags"][:2]
            for label in labels:
                buckets[(post["category"], post["platform"], label)].append(post)
    recommendations = []
    for (category, platform, theme), examples in buckets.items():
        unique_accounts = {post["handle"] for post in examples}
        if len(examples) < 2 and len(unique_accounts) < 2:
            continue
        examples.sort(key=lambda row: row.get("relative_to_account_median") or 0, reverse=True)
        recommendations.append({
            "category": category,
            "platform": platform,
            "theme": theme,
            "account_count": len(unique_accounts),
            "post_count": len(examples),
            "median_lift": round(median(post["relative_to_account_median"] for post in examples), 2),
            "hook_styles": sorted({post["hook_style"] for post in examples}),
            "formats": sorted({post["format"] for post in examples}),
            "example_posts": [post["url"] for post in examples[:3]],
            "suggestion": "Test a fresh 10K Takes angle on {} using a {} format and a {} opening. Treat this as a public-engagement signal, not a guaranteed lift.".format(theme, examples[0]["format"].lower(), examples[0]["hook_style"].lower()),
        })
    return sorted(recommendations, key=lambda row: (row["account_count"], row["median_lift"], row["post_count"]), reverse=True)[:30]


def write_report(report):
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    if os.environ.get("COMPETITOR_INTELLIGENCE_ENABLED", "").strip().lower() != "true":
        print("Competitor intelligence is disabled; no social API requests were made.")
        return

    token = os.environ.get("INSTAGRAM_DISCOVERY_TOKEN", "").strip()
    account_id = os.environ.get("INSTAGRAM_ACCOUNT_ID", "").strip()
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {}
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    competitors = config.get("competitors", [])
    generated = now_utc()
    report = {
        "generated_at": generated.isoformat(),
        "status": "partial",
        "source": "Meta Instagram Business Discovery API",
        "coverage_note": "Only eligible public Instagram Business/Creator accounts are available. Likes and comments are public interaction proxies; reach, watch time, retention, saves, and shares are not assumed available for competitor posts.",
        "platforms": {
            "Instagram": {"status": "pending", "detail": "Requires eligible Meta API access and public Business/Creator target accounts."},
            "TikTok": {"status": "not_connected", "detail": "TikTok does not provide ordinary commercial API access to arbitrary competitor posts."},
            "Facebook": {"status": "not_connected", "detail": "Public Page collection needs separate Meta Page Public Content Access approval."},
        },
        "accounts": [], "posts": [], "recommendations": [], "post_history": {},
    }
    if not token or not account_id:
        if previous.get("posts"):
            report = previous
            report["generated_at"] = generated.isoformat()
            report["status"] = "needs_access"
            report["coverage_note"] = "No new competitor posts were fetched because Meta API credentials are missing. The dashboard is retaining the previous public snapshot, which may be stale."
            report.setdefault("platforms", {})["Instagram"] = {
                "status": "needs_access",
                "detail": "No API request was made because the required secret or account ID is missing.",
            }
        else:
            report["status"] = "needs_access"
            report["platforms"]["Instagram"].update({"status": "needs_access", "detail": "Set up and approve the required Meta API access before enabling daily collection."})
            report["coverage_note"] = "No competitor posts were fetched. The collector is opt-in and requires Meta API access; no scraping is used."
        write_report(report)
        print("Competitor intelligence needs Meta API access; wrote a coverage-only report.")
        return

    report["platforms"]["Instagram"].update({"status": "connected", "detail": "Public Business Discovery results only; some handles may be ineligible or unavailable."})
    accounts = []
    for competitor in competitors:
        if competitor.get("platform") != "Instagram":
            continue
        row = {
            "handle": competitor.get("handle", ""), "platform": "Instagram",
            "category": competitor.get("category", "Other"), "profile_url": competitor.get("profile_url", ""),
            "status": "ok", "posts": [],
        }
        try:
            profile = graph_get(account_id, row["handle"], token)
            if not profile:
                raise RuntimeError("No Business Discovery profile returned; the account may not be a public Business/Creator profile.")
            row["display_name"] = profile.get("name") or profile.get("username")
            row["followers"] = profile.get("followers_count")
            for media in profile.get("media", {}).get("data", []):
                published = parse_time(media.get("timestamp"))
                if not published or (generated - published).days > 60:
                    continue
                row["posts"].append({
                    "id": media.get("id"), "handle": row["handle"], "platform": "Instagram",
                    "category": row["category"], "url": media.get("permalink") or row["profile_url"],
                    "published_at": media.get("timestamp"), "format": post_format(media),
                    "caption": (media.get("caption") or "")[:2000],
                    "likes": media.get("like_count"), "comments": media.get("comments_count"),
                    "followers": profile.get("followers_count"),
                    "hook_style": hook_style(media.get("caption")),
                })
        except (RuntimeError, KeyError, TypeError) as error:
            row["status"] = "unavailable"
            row["error"] = str(error)[:300]
        accounts.append(row)
        time.sleep(0.12)

    report["accounts"] = [{key: value for key, value in account.items() if key != "posts"} for account in accounts]
    posts, history = enrich_posts(accounts, previous, generated.date().isoformat())
    report["posts"] = sorted(posts, key=lambda post: (post["stronger_than_account_baseline"], post.get("relative_to_account_median") or 0), reverse=True)
    report["post_history"] = history
    report["recommendations"] = make_recommendations(posts)
    connected_accounts = sum(account["status"] == "ok" for account in accounts)
    report["status"] = "ready" if connected_accounts == len([c for c in competitors if c.get("platform") == "Instagram"]) else "partial"
    report["coverage_note"] = "{} of {} listed Instagram accounts returned data; {} public posts captured. Rankings compare interaction-per-follower proxies within each account and do not reveal reach or prove causation.".format(
        connected_accounts, len([c for c in competitors if c.get("platform") == "Instagram"]), len(posts))
    write_report(report)
    print("Wrote {} public Instagram post records from {} accounts.".format(len(posts), connected_accounts))


if __name__ == "__main__":
    main()
