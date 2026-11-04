#!/usr/bin/env python3
"""Build a daily, source-linked Minnesota sports content-opportunity digest."""

import datetime as dt
import email.utils
import hashlib
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "content-opportunities.json"
ACCOUNT_CONFIG = ROOT / "config" / "monitored_sources.json"
USER_AGENT = "10K-Takes-Content-Intelligence/1.0 (+https://10000takes.github.io/)"
NOW = dt.datetime.now(dt.timezone.utc)

TEAM_QUERIES = {
    "Vikings": 'Minnesota Vikings OR Vikings NFL',
    "Twins": 'Minnesota Twins OR Twins MLB',
    "Timberwolves": 'Minnesota Timberwolves OR Minnesota Wolves NBA',
    "Lynx": 'Minnesota Lynx WNBA',
    "Wild": 'Minnesota Wild NHL',
    "Gophers": 'Minnesota Gophers football basketball hockey',
    "Minnesota United": 'Minnesota United FC MLS',
    "Minnesota Frost": 'Minnesota Frost PWHL',
}
VIRAL_TERMS = {
    "trade", "traded", "rumor", "rumour", "injury", "injured", "comeback", "record",
    "rivalry", "rival", "playoff", "playoffs", "upset", "clutch", "controversy",
    "reaction", "viral", "breakout", "draft", "waived", "suspended", "walkoff",
    "walk-off", "overtime", "game-winner", "historic", "dominant", "collapse",
}
STOP = set("the and for with from that this have after over into what when where why who how are was were will could should their they them then than about latest minnesota vikings twins timberwolves wolves lynx wild gophers united frost sport sports team teams says said report reports".split())
TEAM_TERMS = {
    "Vikings": {"vikings", "minnesota", "nfl"},
    "Twins": {"twins", "minnesota", "mlb"},
    "Timberwolves": {"timberwolves", "wolves", "minnesota", "nba"},
    "Lynx": {"lynx", "minnesota", "wnba"},
    "Wild": {"wild", "minnesota", "nhl"},
    "Gophers": {"gophers", "minnesota", "ncaa"},
    "Minnesota United": {"minnesota united", "loons", "mls"},
    "Minnesota Frost": {"minnesota frost", "frost", "pwhl"},
}


def fetch(url, timeout=20):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def parse_feed(xml_bytes, source_name, source_kind, platform="News", team_hint=None, category="Minnesota team news"):
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []
    rows = []
    for item in root.findall(".//item")[:30]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link or not link.startswith("https://"):
            continue
        published = None
        raw_date = item.findtext("pubDate")
        if raw_date:
            try:
                published = email.utils.parsedate_to_datetime(raw_date)
                if published.tzinfo is None:
                    published = published.replace(tzinfo=dt.timezone.utc)
                published = published.astimezone(dt.timezone.utc)
            except (TypeError, ValueError, OverflowError):
                published = None
        publisher = item.findtext("source") or source_name
        rows.append({
            "title": html.unescape(re.sub(r"\s+-\s+[^-]+$", "", title)).strip(),
            "url": link,
            "published_at": published.isoformat() if published else None,
            "source": publisher.strip(),
            "source_kind": source_kind,
            "source_platform": platform,
            "category": category,
            "tracked_account": source_name if source_kind == "tracked_account" else None,
            "team_hint": team_hint,
            "description": html.unescape(re.sub(r"<[^>]+>", " ", item.findtext("description") or "")).strip()[:400],
        })
    return rows


def google_news_url(query):
    encoded = urllib.parse.quote(query, safe="")
    return f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"


def word_set(text):
    return {word.lower() for word in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", text) if word.lower() not in STOP}


def detect_team(title, fallback="Minnesota sports"):
    low = title.lower()
    anchors = {
        "Vikings": ("vikings",), "Twins": ("twins",), "Timberwolves": ("timberwolves", "wolves"),
        "Lynx": ("lynx",), "Wild": ("minnesota wild",), "Gophers": ("gophers",),
        "Minnesota United": ("minnesota united", "loons"), "Minnesota Frost": ("minnesota frost", "pwhl", "frost"),
    }
    for team, terms in anchors.items():
        if any(term in low for term in terms):
            return team
    return fallback


def score_opportunity(item, own_performance):
    title = item["title"]
    team = item["team"]
    published = item.get("published_at")
    age_hours = 120.0
    if published:
        try:
            age_hours = max(0.0, (NOW - dt.datetime.fromisoformat(published)).total_seconds() / 3600)
        except ValueError:
            pass
    timeliness = max(5, round(100 * (0.5 ** (age_hours / 36))))
    terms = word_set(title)
    team_tokens = TEAM_TERMS.get(team, set())
    relevance = min(100, 55 + 12 * sum(1 for term in team_tokens if term in title.lower()))
    mention_count = item.get("corroborating_items", 1)
    corroboration = min(100, 30 + 20 * max(0, mention_count - 1))
    viral_matches = sorted(terms & VIRAL_TERMS)
    virality = min(100, 38 + 13 * len(viral_matches) + 8 * min(3, mention_count - 1))
    ease = 88  # Quick-reaction and explain-the-news formats need no special production.
    performance_note = None
    if own_performance:
        ease = min(100, ease + 5)
        performance_note = own_performance
    total = round(0.35 * relevance + 0.30 * timeliness + 0.20 * virality + 0.15 * ease)
    if any(x in terms for x in {"injury", "injured", "trade", "traded", "draft", "waived", "suspended"}):
        format_name = "Fast explainer + reaction"
        hook = f"What {team} fans need to know about this: {title}"
    elif any(x in terms for x in {"record", "historic", "comeback", "walkoff", "walk-off", "overtime", "game-winner"}):
        format_name = "Big-moment replay + fan reaction"
        hook = f"This {team} moment deserves a second look: {title}"
    else:
        format_name = "Quick take + 3-point breakdown"
        hook = f"The key question behind this {team} story: {title}"
    adaptations = {
        "Instagram": "Reel: cold open with the question; use captions and a concise 3-point breakdown.",
        "Facebook": "Native short video: lead with the fan impact and invite a specific, respectful debate.",
        "TikTok": "Vertical reaction: put the hook on screen immediately, then explain the source-backed context.",
        "X": "Post a concise take with one verified stat or quote and link to the source.",
    }
    return {
        "id": item["id"], "score": total,
        "score_breakdown": {"relevance": relevance, "timeliness": timeliness, "virality_potential": virality, "ease_of_execution": ease},
        "team": team, "title": title, "url": item["url"], "published_at": published,
        "category": item.get("category") or "Other",
        "source": item["source"], "source_kind": item["source_kind"],
        "tracked_account": item.get("tracked_account"),
        "corroborating_items": mention_count, "trend_signal": "Multiple sources" if mention_count >= 3 else "Early signal" if mention_count == 2 else "Single-source story",
        "viral_cues": viral_matches[:4], "format": format_name, "hook_draft": hook,
        "platform_adaptations": adaptations, "own_performance_note": performance_note,
        "editorial_safeguard": "Verify the latest facts and use the linked source before recording. Hook is a draft, not a factual claim.",
    }


def load_account_sources():
    return load_source_config().get("accounts", [])


def load_competitors():
    return load_source_config().get("competitors", [])


def load_source_config():
    if not ACCOUNT_CONFIG.exists():
        return {}
    try:
        config = json.loads(ACCOUNT_CONFIG.read_text(encoding="utf-8"))
        return config if isinstance(config, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def load_own_performance():
    path = ROOT / "top_posts.csv"
    if not path.exists():
        return None
    # Kept deliberately lightweight: owned-post data enriches feasibility, not story truth.
    try:
        import csv
        with path.open(newline="", encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        recent = [row for row in rows if row.get("url") and row.get("views", "").strip().isdigit()]
        if len(recent) >= 3:
            return f"{len(recent)} recent owned posts with view counts are available for a later format-level benchmark."
    except (OSError, UnicodeError):
        return None
    return None


def collect():
    articles = []
    failures = []
    for team, query in TEAM_QUERIES.items():
        try:
            articles.extend(parse_feed(fetch(google_news_url(query)), "Google News RSS", "news", "News", team, "Minnesota team news"))
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            failures.append(f"{team}: {type(error).__name__}")
    for account in load_account_sources():
        feed_url = str(account.get("feed_url", "")).strip()
        query = str(account.get("search_query", "")).strip()
        source_label = str(account.get("name") or "Tracked account")
        platform = str(account.get("platform") or "Unknown")
        category = str(account.get("category") or "Tracked accounts")
        if not feed_url.startswith("https://") and not query:
            continue
        try:
            source_url = feed_url if feed_url.startswith("https://") else google_news_url(query)
            articles.extend(parse_feed(fetch(source_url), source_label, "tracked_account", platform, account.get("team"), category))
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            failures.append(f"{account.get('name', 'tracked account')}: {type(error).__name__}")

    deduped = {}
    for article in articles:
        key = article["url"].split("?")[0]
        deduped.setdefault(key, article)
    cutoff = NOW - dt.timedelta(days=4)
    current = []
    for article in deduped.values():
        if article.get("published_at"):
            try:
                if dt.datetime.fromisoformat(article["published_at"]) < cutoff:
                    continue
            except ValueError:
                pass
        article["team"] = detect_team(article["title"], article.get("team_hint") or "Minnesota sports")
        # Similar titles count as corroboration only across distinct publishers.
        article["id"] = hashlib.sha256((article["url"] + article["title"]).encode("utf-8")).hexdigest()[:16]
        current.append(article)
    title_words = {article["id"]: word_set(article["title"]) for article in current}
    for article in current:
        words = title_words[article["id"]]
        publishers = {article["source"]}
        for other in current:
            if other["id"] == article["id"] or other["team"] != article["team"]:
                continue
            other_words = title_words[other["id"]]
            union = words | other_words
            similarity = len(words & other_words) / len(union) if union else 0
            if similarity >= 0.35:
                publishers.add(other["source"])
        article["corroborating_items"] = len(publishers)
    performance = load_own_performance()
    scored = [score_opportunity(article, performance) for article in current]
    scored.sort(key=lambda row: row["score"], reverse=True)
    report = {
        "generated_at": NOW.isoformat(),
        "status": "partial" if failures else "ok",
        "source_scope": "Google News RSS searches for Minnesota teams plus configured RSS feeds for tracked accounts.",
        "source_count": len(TEAM_QUERIES) + len(load_account_sources()),
        "articles_scanned": len(current),
        "social_trend_coverage": {
            "Instagram": "not_connected", "Facebook": "not_connected", "TikTok": "manual_reference", "X": "not_connected",
            "note": "Current official public interfaces do not provide one free, automated cross-platform trending feed. TikTok Creative Center offers public trend discovery; no live social trend counts are claimed in this report.",
        },
        "coverage_note": "News and RSS signals update automatically. Tracked-account coverage starts when RSS feeds are added to config/monitored_sources.json. Social-platform trends are not inferred from news volume.",
        "source_failures": failures,
        "opportunities": scored[:20],
        "competitors": load_competitors(),
    }
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def email_body(report):
    lines = [f"10K Takes daily content opportunities · {NOW.date().isoformat()}", "", f"{len(report['opportunities'])} opportunities ranked by evidence-based heuristics.", ""]
    for index, item in enumerate(report["opportunities"][:8], start=1):
        lines.extend([
            f"{index}. [{item['score']}/100] {item['category']} · {item['team']}: {item['title']}",
            f"   Why now: {item['trend_signal']} · {item['corroborating_items']} publisher(s) · {item['source']}",
            f"   Format: {item['format']}", f"   Hook draft: {item['hook_draft']}", f"   Source: {item['url']}", "",
        ])
    lines.extend(["Scores are triage aids, not predictions. Verify the facts and source before publishing.", "Social trend feeds are not connected; see the dashboard for current coverage."])
    return "\n".join(lines)


def send_email(report):
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    recipient = os.environ.get("OPPORTUNITIES_EMAIL_TO", "").strip()
    sender = os.environ.get("RESEND_FROM", "").strip()
    if not (api_key and recipient and sender):
        print("Email not sent: configure RESEND_API_KEY, OPPORTUNITIES_EMAIL_TO, and RESEND_FROM to enable it.")
        return
    body = json.dumps({
        "from": sender,
        "to": [recipient],
        "subject": f"10K Takes content opportunities — {NOW.date().isoformat()}",
        "text": email_body(report),
    }).encode("utf-8")
    request = urllib.request.Request(
        "https://api.resend.com/emails", data=body, method="POST",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "User-Agent": USER_AGENT,
                 "Idempotency-Key": f"10k-content-opportunities-{NOW.date().isoformat()}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            print(f"Daily opportunities email accepted by provider (HTTP {response.status}).")
    except urllib.error.HTTPError as error:
        print(f"Email provider returned HTTP {error.code}; opportunity report was still generated.", file=sys.stderr)
        raise


if __name__ == "__main__":
    if sys.argv[1:] == ["--email-only"]:
        try:
            report = json.loads(OUTPUT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            sys.exit(f"Cannot load {OUTPUT.name} for email: {error}")
        send_email(report)
    elif sys.argv[1:]:
        sys.exit("Usage: generate_content_opportunities.py [--email-only]")
    else:
        report = collect()
        print(f"Generated {len(report['opportunities'])} ranked opportunity/ies from {report['articles_scanned']} recent source items.")
