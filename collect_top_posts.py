#!/usr/bin/env python3
"""
Collects the main account's recent posts (last 30 days) on every platform except TikTok
and saves them to top_posts.csv with per-post numbers. The dashboard ranks last week's posts
from this file and compares each one with that platform's recent posts.
(TikTok is collected inside collect_tiktok.py because it shares that script's token refresh.)

Columns: snapshot,platform,url,posted,type,caption,views,likes,comments,shares,saves
Each run replaces a platform's rows, so the file always holds the latest numbers.
Set TOP_POSTS_X=0 to skip X, which charges a small fee per post read.
Standard library only.
"""
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

from campaign_common import save_top_posts, tp_row
from collect_posts import fetch, graph_get

DAYS = 30
CUTOFF = datetime.now(timezone.utc) - timedelta(days=DAYS)


def parse_time(s):
    s = (s or "").replace("Z", "+00:00")
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s)
    return datetime.fromisoformat(s)


def recent(ts):
    try:
        return parse_time(ts) >= CUTOFF
    except ValueError:
        return False


def multi(data):
    """Turn an insights response into {metric: value}."""
    out = {}
    for item in data.get("data", []):
        if "total_value" in item:
            out[item["name"]] = int(item["total_value"].get("value", 0))
        elif item.get("values"):
            out[item["name"]] = int(item["values"][0].get("value", 0))
    return out


# ---------------- YouTube ----------------
def youtube():
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("YOUTUBE_API_KEY is not set")
    h = {"X-Goog-Api-Key": key}
    base = "https://www.googleapis.com/youtube/v3/"
    ch = fetch(base + "channels?" + urllib.parse.urlencode({"part": "contentDetails", "forHandle": "@10K_Takes"}), h, [key])
    uploads = ch["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    items = fetch(base + "playlistItems?" + urllib.parse.urlencode(
        {"part": "contentDetails", "playlistId": uploads, "maxResults": 25}), h, [key]).get("items", [])
    ids = [i["contentDetails"]["videoId"] for i in items]
    rows = []
    if ids:
        vids = fetch(base + "videos?" + urllib.parse.urlencode(
            {"part": "snippet,statistics,contentDetails", "id": ",".join(ids)}), h, [key]).get("items", [])
        for v in vids:
            sn, st = v["snippet"], v.get("statistics", {})
            if not recent(sn["publishedAt"]):
                continue
            m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", v.get("contentDetails", {}).get("duration", ""))
            secs = (int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)) if m else 999
            rows.append(tp_row("YouTube", "https://youtube.com/watch?v=" + v["id"], sn["publishedAt"],
                               "Short" if secs <= 60 else "Video", sn.get("title"),
                               st.get("viewCount"), st.get("likeCount"), st.get("commentCount"), 0, 0))
    return rows


# ---------------- X / Twitter ----------------
def x_posts():
    if os.environ.get("TOP_POSTS_X", "1") == "0":
        print("X skipped (TOP_POSTS_X=0)")
        return None
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("X_BEARER_TOKEN is not set")
    h = {"Authorization": "Bearer " + token}
    uid = fetch("https://api.x.com/2/users/by/username/10K_Takes", h, [token])["data"]["id"]
    q = urllib.parse.urlencode({"max_results": 30, "exclude": "retweets,replies", "tweet.fields": "created_at,public_metrics,text,referenced_tweets",
                                "start_time": CUTOFF.strftime("%Y-%m-%dT%H:%M:%SZ")})
    rows = []
    for t in fetch("https://api.x.com/2/users/{}/tweets?{}".format(uid, q), h, [token]).get("data", []):
        m = t.get("public_metrics", {})
        kind = "Quote" if any(r.get("type") == "quoted" for r in t.get("referenced_tweets", [])) else "Post"
        rows.append(tp_row("X/Twitter", "https://x.com/10K_Takes/status/" + t["id"], t["created_at"], kind, t.get("text"),
                           m.get("impression_count"), m.get("like_count"), m.get("reply_count"),
                           (m.get("retweet_count") or 0) + (m.get("quote_count") or 0), m.get("bookmark_count")))
    return rows


# ---------------- Instagram ----------------
def instagram():
    ig, tok = os.environ.get("INSTAGRAM_ACCOUNT_ID", "").strip(), os.environ.get("FACEBOOK_PAGE_TOKEN", "").strip()
    if not ig or not tok:
        raise RuntimeError("INSTAGRAM_ACCOUNT_ID / FACEBOOK_PAGE_TOKEN not set")
    media = graph_get(ig + "/media", {"fields": "id,permalink,timestamp,media_type,media_product_type,caption,like_count,comments_count",
                                      "limit": 25}, tok).get("data", [])
    rows = []
    for m in media:
        if not recent(m.get("timestamp")):
            continue
        try:
            ins = multi(graph_get(m["id"] + "/insights", {"metric": "views,shares,saved"}, tok))
        except RuntimeError:
            ins = {}
            for metric in ("views", "shares", "saved"):
                try:
                    ins.update(multi(graph_get(m["id"] + "/insights", {"metric": metric}, tok)))
                except RuntimeError:
                    pass
        kind = "Reel" if m.get("media_product_type") == "REELS" else {"CAROUSEL_ALBUM": "Carousel", "VIDEO": "Video"}.get(m.get("media_type"), "Image")
        rows.append(tp_row("Instagram", m["permalink"], m["timestamp"], kind, m.get("caption"), ins.get("views"),
                           m.get("like_count"), m.get("comments_count"), ins.get("shares"), ins.get("saved")))
    return rows


# ---------------- Facebook ----------------
def facebook():
    pid, tok = os.environ.get("FACEBOOK_PAGE_ID", "").strip(), os.environ.get("FACEBOOK_PAGE_TOKEN", "").strip()
    if not pid or not tok:
        raise RuntimeError("FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN not set")
    posts = graph_get(pid + "/posts", {
        "fields": "id,created_time,permalink_url,message,status_type,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)",
        "limit": 25, "since": int(CUTOFF.timestamp())}, tok).get("data", [])
    rows = []
    for p in posts:
        views = None
        try:
            views = multi(graph_get(p["id"] + "/insights", {"metric": "post_media_view"}, tok)).get("post_media_view")
        except RuntimeError as e:
            print("::notice::Facebook views unavailable for a post: {}".format(str(e)[:120]))
        kind = {"added_video": "Video", "added_photos": "Photo", "shared_story": "Link"}.get(p.get("status_type"), "Post")
        rows.append(tp_row("Facebook", p.get("permalink_url", ""), p["created_time"], kind, p.get("message"), views,
                           (p.get("reactions", {}).get("summary") or {}).get("total_count"),
                           (p.get("comments", {}).get("summary") or {}).get("total_count"),
                           (p.get("shares") or {}).get("count", 0), 0))
    return rows


# ---------------- Threads ----------------
def threads():
    tok = os.environ.get("THREADS_ACCESS_TOKEN_10K_TAKES", "").strip()
    if not tok:
        raise RuntimeError("THREADS_ACCESS_TOKEN_10K_TAKES is not set")
    base = "https://graph.threads.net/v1.0/"
    posts = fetch(base + "me/threads?" + urllib.parse.urlencode(
        {"fields": "id,permalink,timestamp,text,media_type", "limit": 25, "access_token": tok}), None, [tok]).get("data", [])
    rows = []
    for p in posts:
        if not recent(p.get("timestamp")):
            continue
        try:
            ins = multi(fetch(base + p["id"] + "/insights?" + urllib.parse.urlencode(
                {"metric": "views,likes,replies,reposts,quotes", "access_token": tok}), None, [tok]))
        except RuntimeError as e:
            print("::notice::Threads insights unavailable for a post: {}".format(str(e)[:120]))
            ins = {}
        kind = {"IMAGE": "Image", "VIDEO": "Video", "CAROUSEL_ALBUM": "Carousel"}.get(p.get("media_type"), "Text")
        rows.append(tp_row("Threads", p["permalink"], p["timestamp"], kind, p.get("text"), ins.get("views"), ins.get("likes"),
                           ins.get("replies"), (ins.get("reposts") or 0) + (ins.get("quotes") or 0), 0))
    return rows


JOBS = [("YouTube", youtube), ("X/Twitter", x_posts), ("Instagram", instagram), ("Facebook", facebook), ("Threads", threads)]


def main():
    failed = []
    for platform, fn in JOBS:
        try:
            rows = fn()
        except (RuntimeError, KeyError, IndexError) as e:
            failed.append(platform)
            print("::error::{}: {}".format(platform, e))
            continue
        if rows is None:
            continue
        save_top_posts(platform, rows)
        print("{}: {} post(s) from the last {} days saved".format(platform, len(rows), DAYS))
    if failed:
        sys.exit("Failed: " + ", ".join(failed))


if __name__ == "__main__":
    main()
