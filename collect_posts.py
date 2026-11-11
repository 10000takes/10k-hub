#!/usr/bin/env python3
"""
Collects numbers for the sponsored posts listed in posts.csv and saves them to
post_metrics.csv (date,url,metric,value). Metrics: views, likes, comments, shares, reposts, saves.

Covers YouTube and X (any public post), Instagram and Threads (our own accounts),
and Facebook posts published by the main Page. TikTok is collected inside
collect_tiktok.py, because it shares that script's token refresh. Creator-owned
posts use the manual columns in posts.csv.
Only posts published in the last 35 days are re-checked, so older months stay frozen.
Standard library only.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from campaign_common import env_name, metric_rows, read_posts, save_post_metrics

GRAPH = "v26.0"


def fetch(url, headers=None, secrets=()):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:250]
        for s in secrets:
            body = body.replace(s, "***")
        raise RuntimeError("HTTP {}: {}".format(e.code, body))
    except urllib.error.URLError as e:
        raise RuntimeError("unreachable: {}".format(e.reason))


def insight_value(data):
    for item in data.get("data", []):
        if "total_value" in item:
            return int(item["total_value"].get("value", 0))
        vals = item.get("values") or []
        if vals:
            return int(vals[0].get("value", 0))
    return None


# ---------------- YouTube ----------------
def youtube(posts):
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        raise RuntimeError("YOUTUBE_API_KEY is not set")
    ids = {}
    for p in posts:
        m = re.search(r"(?:youtu\.be/|v=|/shorts/|/embed/|/live/)([A-Za-z0-9_-]{11})", p["url"])
        if m:
            ids[m.group(1)] = p["key"]
    rows, found = [], set()
    items = list(ids)
    for i in range(0, len(items), 50):
        q = urllib.parse.urlencode({"part": "statistics", "id": ",".join(items[i:i + 50])})
        data = fetch("https://www.googleapis.com/youtube/v3/videos?" + q, {"X-Goog-Api-Key": key}, [key])
        for v in data.get("items", []):
            s = v.get("statistics", {})
            found.add(v["id"])
            rows += metric_rows(ids[v["id"]], {"views": s.get("viewCount"), "likes": s.get("likeCount"),
                                               "comments": s.get("commentCount")})
    for vid in set(ids) - found:
        print("::notice::YouTube video {} not found (private or deleted?)".format(vid))
    return rows


# ---------------- X / Twitter ----------------
def x_posts(posts):
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not token:
        raise RuntimeError("X_BEARER_TOKEN is not set")
    ids = {}
    for p in posts:
        m = re.search(r"/status(?:es)?/(\d+)", p["url"])
        if m:
            ids[m.group(1)] = p["key"]
    rows, items = [], list(ids)
    for i in range(0, len(items), 100):
        q = urllib.parse.urlencode({"ids": ",".join(items[i:i + 100]), "tweet.fields": "public_metrics"})
        data = fetch("https://api.x.com/2/tweets?" + q, {"Authorization": "Bearer " + token}, [token])
        for t in data.get("data", []):
            m = t.get("public_metrics", {})
            rows += metric_rows(ids[t["id"]], {
                "views": m.get("impression_count"), "likes": m.get("like_count"),
                "comments": m.get("reply_count"),
                "shares": (m.get("retweet_count") or 0) + (m.get("quote_count") or 0),
                "saves": m.get("bookmark_count")})
    return rows


# ---------------- Instagram (our accounts) ----------------
def graph_get(path, params, token):
    url = "https://graph.facebook.com/{}/{}?".format(GRAPH, path) + urllib.parse.urlencode(params)
    return fetch(url, {"Authorization": "Bearer " + token}, [token])


def ig_context(account):
    if account.casefold() == "10k takes":
        ig, tok = os.environ.get("INSTAGRAM_ACCOUNT_ID", "").strip(), os.environ.get("FACEBOOK_PAGE_TOKEN", "").strip()
        if not ig or not tok:
            raise RuntimeError("INSTAGRAM_ACCOUNT_ID / FACEBOOK_PAGE_TOKEN not set")
        return ig, tok
    from collect_facebook_subsidiaries import PAGES
    page = PAGES.get(account)
    sysTok = os.environ.get("FACEBOOK_SYSTEM_USER_TOKEN", "").strip()
    if not page or page.startswith("REPLACE_") or not sysTok:
        raise RuntimeError("no Page ID or system token for {}".format(account))
    page_tok = graph_get(page, {"fields": "access_token"}, sysTok)["access_token"]
    ig = (graph_get(page, {"fields": "instagram_business_account"}, page_tok).get("instagram_business_account") or {}).get("id")
    if not ig:
        raise RuntimeError("no Instagram account linked to the {} Page".format(account))
    return ig, page_tok


def instagram(posts):
    rows = []
    for account in sorted({p.get("account", "") for p in posts}):
        mine = [p for p in posts if p.get("account", "") == account]
        try:
            ig, tok = ig_context(account)
            media = graph_get(ig + "/media", {"fields": "id,permalink", "limit": 50}, tok).get("data", [])
        except RuntimeError as e:
            print("::warning::Instagram {}: {}".format(account or "(no account)", e))
            continue
        for p in mine:
            m = re.search(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", p["url"])
            hit = next((x for x in media if m and "/" + m.group(1) in x.get("permalink", "")), None)
            if not hit:
                print("::notice::Instagram post not found among the 50 latest of {}: {}".format(account, p["url"]))
                continue
            # With Facebook Login, IG Media exposes all-surface counters for
            # boosted media. Prefer these object fields over insight metrics,
            # which can reflect only organic activity.
            fields = ("total_views_count,total_like_count,total_comments_count,"
                      "shares_count,reposts_count,saved_count")
            try:
                node = graph_get(hit["id"], {"fields": fields}, tok)
            except RuntimeError as e:
                node = {}
                print("::notice::Instagram aggregate media fields for {}: {}".format(p["url"], e))
            vals = {name: node[field] for field, name in (
                ("total_views_count", "views"), ("total_like_count", "likes"),
                ("total_comments_count", "comments"), ("shares_count", "shares"),
                ("reposts_count", "reposts"), ("saved_count", "saves"))
                if node.get(field) is not None}
            for metric, name in (("total_views", "views"), ("total_likes", "likes"),
                                 ("total_comments", "comments"), ("shares", "shares"),
                                 ("reposts", "reposts"), ("saved", "saves")):
                if name in vals:
                    continue
                try:
                    vals[name] = insight_value(graph_get(hit["id"] + "/insights", {"metric": metric}, tok))
                except RuntimeError as e:
                    print("::notice::Instagram {} for {}: {}".format(metric, p["url"], e))
            print("Instagram campaign metrics {}: {}".format(
                p["url"], ", ".join("{}={}".format(k, v) for k, v in sorted(vals.items())) or "none returned"))
            rows += metric_rows(p["key"], vals)
    return rows


# ---------------- Threads (our accounts) ----------------
def threads(posts):
    rows = []
    for account in sorted({p.get("account", "") for p in posts}):
        token = os.environ.get(env_name("THREADS_ACCESS_TOKEN_", account), "").strip()
        if not token:
            print("::warning::Threads {}: no token saved for this account".format(account or "(no account)"))
            continue
        base = "https://graph.threads.net/v1.0/"
        try:
            media = fetch(base + "me/threads?" + urllib.parse.urlencode(
                {"fields": "id,permalink", "limit": 50, "access_token": token}), None, [token]).get("data", [])
        except RuntimeError as e:
            print("::warning::Threads {}: {}".format(account, e))
            continue
        for p in (x for x in posts if x.get("account", "") == account):
            m = re.search(r"/post/([A-Za-z0-9_-]+)", p["url"])
            hit = next((x for x in media if m and "/post/" + m.group(1) in x.get("permalink", "")), None)
            if not hit:
                print("::notice::Threads post not found among the 50 latest of {}: {}".format(account, p["url"]))
                continue
            vals = {}
            for metric, name in (("views", "views"), ("likes", "likes"), ("replies", "comments"),
                                 ("reposts", "shares"), ("quotes", None)):
                try:
                    v = insight_value(fetch(base + hit["id"] + "/insights?" + urllib.parse.urlencode(
                        {"metric": metric, "access_token": token}), None, [token]))
                except RuntimeError as e:
                    print("::notice::Threads {} for {}: {}".format(metric, p["url"], e))
                    continue
                if name:
                    vals[name] = v
                elif v is not None:
                    vals["shares"] = (vals.get("shares") or 0) + v
            rows += metric_rows(p["key"], vals)
    return rows


# ---------------- Facebook (main Page posts) ----------------
def facebook_post_refs(url, page_id=""):
    """Extract stable post identifiers from common Facebook permalink forms."""
    refs = set()
    parsed = urlparse(url or "")
    query = parse_qs(parsed.query)
    story = (query.get("story_fbid") or [""])[0]
    owner = (query.get("id") or [page_id])[0]
    if story and owner:
        refs.add("id:" + owner + "_" + story)
    for key in ("fbid", "v"):
        value = (query.get(key) or [""])[0]
        if value:
            refs.add("id:" + value)
    parts = [part for part in parsed.path.split("/") if part]
    for marker in ("posts", "videos", "reel", "reels"):
        if marker in parts:
            idx = parts.index(marker)
            if idx + 1 < len(parts):
                refs.add("id:" + parts[idx + 1])
    # Some canonical links contain the composite Page_Post ID directly.
    for part in parts:
        if re.match(r"^\d+_(?:\d+|pfbid[A-Za-z0-9]+)$", part):
            refs.add("id:" + part)
    return refs


def resolve_facebook_url(url):
    """Follow public permalink redirects (for /share/p/ links) without parsing page content."""
    req = urllib.request.Request(url, headers={"User-Agent": "10K-Takes-dashboard/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.geturl()
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
        print("::notice::Could not resolve Facebook permalink redirect for {}: {}".format(url, e))
        return url


def facebook(posts):
    page_id = os.environ.get("FACEBOOK_PAGE_ID", "").strip()
    token = os.environ.get("FACEBOOK_PAGE_TOKEN", "").strip()
    if not page_id or not token:
        raise RuntimeError("FACEBOOK_PAGE_ID / FACEBOOK_PAGE_TOKEN not set")

    since = int((datetime.now(timezone.utc) - timedelta(days=35)).timestamp())
    fields = ("id,created_time,permalink_url,status_type,shares,"
              "reactions.summary(true).limit(0),comments.summary(true).limit(0)")
    page = graph_get(page_id + "/posts", {"fields": fields, "limit": 100, "since": since}, token)
    page_posts = page.get("data", [])
    # Walk older pages only while they could still contain a tracked campaign post.
    while page.get("paging", {}).get("next") and len(page_posts) < 1000:
        next_url = page["paging"]["next"]
        page = fetch(next_url, headers={"Authorization": "Bearer " + token}, secrets=[token])
        batch = page.get("data", [])
        page_posts.extend(batch)
        if not batch:
            break

    by_ref = {}
    for item in page_posts:
        refs = facebook_post_refs(item.get("permalink_url", ""), page_id)
        refs.update(facebook_post_refs(item.get("id", ""), page_id))
        for ref in refs:
            by_ref[ref] = item

    rows = []
    for post in posts:
        possible_urls = [post["url"]]
        if not facebook_post_refs(post["url"], page_id):
            resolved = resolve_facebook_url(post["url"])
            if resolved != post["url"]:
                possible_urls.append(resolved)
        refs = set()
        for url in possible_urls:
            refs.update(facebook_post_refs(url, page_id))
        match = next((by_ref[ref] for ref in refs if ref in by_ref), None)
        if not match:
            print("::notice::Facebook campaign post not found in the main Page's recent published posts: {}".format(post["url"]))
            continue

        values = {}
        try:
            views = insight_value(graph_get(match["id"] + "/insights", {"metric": "post_media_view"}, token))
            if views is not None:
                values["views"] = views
        except RuntimeError as e:
            print("::notice::Facebook post views unavailable for {}: {}".format(post["url"], e))

        reaction_summary = match.get("reactions", {}).get("summary", {})
        comment_summary = match.get("comments", {}).get("summary", {})
        if reaction_summary.get("total_count") is not None:
            values["likes"] = reaction_summary["total_count"]
        if comment_summary.get("total_count") is not None:
            values["comments"] = comment_summary["total_count"]
        if match.get("shares", {}).get("count") is not None:
            values["shares"] = match["shares"]["count"]
        detail = ", ".join("{}={}".format(k, v) for k, v in sorted(values.items())) or "metrics unavailable"
        print("Facebook campaign metrics {}: {}".format(post["url"], detail))
        rows += metric_rows(post["key"], values)
    return rows


JOBS = [("YouTube", youtube), ("X/Twitter", x_posts), ("Instagram", instagram),
        ("Facebook", facebook), ("Threads", threads)]


def main():
    all_rows, failed = [], []
    for platform, fn in JOBS:
        posts = read_posts(platform=platform)
        if not posts:
            continue
        try:
            rows = fn(posts)
        except RuntimeError as e:
            failed.append(platform)
            print("::error::{}: {}".format(platform, e))
            continue
        all_rows += rows
        print("{}: {} tracked post(s), {} number(s) saved".format(platform, len(posts), len(rows)))
    if all_rows:
        save_post_metrics(all_rows)
    if not all_rows and not failed:
        print("No tracked posts to collect (posts.csv is empty or all posts are older than 35 days).")
    if failed:
        sys.exit("Failed: " + ", ".join(failed))


if __name__ == "__main__":
    main()
