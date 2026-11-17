#!/usr/bin/env python3
"""Generate and email a weekly 10K Takes analytics PDF from saved snapshots."""
import argparse
import base64
import csv
import html
import json
import os
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (Paragraph, SimpleDocTemplate, Spacer, Table,
                                TableStyle, PageBreak)

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / ".github" / "content-report-data"
SNAPSHOTS = DATA_DIR / "snapshots"
REPORTS = DATA_DIR / "weekly-reports"
TZ = ZoneInfo("America/Chicago")
MAIN = "10K Takes"
SUBSIDIARIES = ("Wild Takes", "10K Howls", "State of Skol", "The Underline", "Captain's Patch")
MAIN_PLATFORMS = ("Facebook", "Instagram", "TikTok", "Threads", "X/Twitter", "YouTube")
SUB_PLATFORMS = ("Facebook", "Instagram", "TikTok", "Threads", "X/Twitter")
EXPOSURE = {"X/Twitter": ("views", "impressions"), "default": ("views", "views")}
NAVY = colors.HexColor("#14212b")
GREEN = colors.HexColor("#43b895")
INK = colors.HexColor("#18232c")
MUTED = colors.HexColor("#63717d")
RULE = colors.HexColor("#d7e0e4")
PALE = colors.HexColor("#edf4f3")


def read_snapshot(day):
    path = SNAPSHOTS / (day.isoformat() + ".json")
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("snapshot_date") != day.isoformat() or not isinstance(value.get("posts"), list):
        raise ValueError("Invalid saved snapshot: " + str(path))
    return value


def as_int(value):
    try:
        if value is None or str(value).strip() == "":
            return None
        result = int(value)
        return result if result >= 0 else None
    except (TypeError, ValueError):
        return None


def fmt(value, signed=False):
    if value is None:
        return "Unavailable"
    return f"{int(value):+,}" if signed else f"{int(value):,}"


def pct_change(current, previous):
    if current is None or previous is None or previous == 0:
        return "Unavailable" if current is None or previous is None else "--"
    return f"{(current - previous) / previous * 100:+.1f}%"


def pdf_text(value):
    """Keep readable text while omitting emoji/symbol glyphs unsupported by Helvetica."""
    text = "".join(char for char in str(value)
                   if unicodedata.category(char) not in ("So", "Sk", "Cn", "Cs"))
    return " ".join(text.split())


def post_key(row):
    return (str(row.get("platform", "")).casefold(), str(row.get("url", "")).rstrip("/"))


def exposure_value(row):
    return as_int(row.get("views"))


def period_posts(start_day, end_day):
    """Sum daily post-counter changes across [start_day, end_day) captures."""
    accumulated = {}
    metadata = {}
    covered_pairs = 0
    missing_days = []
    platform_days = {}
    for offset in range((end_day - start_day).days):
        left_day = start_day + timedelta(days=offset)
        before, after = read_snapshot(left_day), read_snapshot(left_day + timedelta(days=1))
        if not before or not after:
            missing_days.append(left_day.isoformat())
            continue
        old_rows = {post_key(row): row for row in before["posts"]}
        old_platforms = {row.get("platform") for row in before["posts"] if exposure_value(row) is not None}
        new_platforms = {row.get("platform") for row in after["posts"] if exposure_value(row) is not None}
        for platform in old_platforms & new_platforms:
            platform_days[platform] = platform_days.get(platform, 0) + 1
        for row in after["posts"]:
            key = post_key(row)
            old = old_rows.get(key)
            current_count = exposure_value(row)
            if current_count is None:
                continue
            if old:
                prior_count = exposure_value(old)
                if prior_count is None or current_count < prior_count:
                    continue
                delta = current_count - prior_count
            else:
                # A post first seen after publication within this reporting window has
                # no start counter; its cumulative counter is its within-window activity.
                try:
                    posted = datetime.fromisoformat(str(row.get("posted_at", "")).replace("Z", "+00:00"))
                    if posted.tzinfo is None or not (start_day <= posted.astimezone(TZ).date() < end_day):
                        continue
                except (TypeError, ValueError):
                    continue
                delta = current_count
            covered_pairs += 1
            accumulated[key] = accumulated.get(key, 0) + delta
            metadata[key] = row
    # Partial windows are not ranked as if they represented a complete week.
    complete_window = not missing_days and all(
        platform_days.get(platform, 0) == (end_day - start_day).days
        for platform in ("Facebook", "Instagram", "TikTok", "Threads", "X/Twitter", "YouTube"))
    posts = []
    for key, value in accumulated.items():
        if not complete_window:
            break
        row = metadata[key]
        platform = row.get("platform", "Unknown")
        try:
            published = datetime.fromisoformat(str(row.get("posted_at", "")).replace("Z", "+00:00"))
            published_label = published.astimezone(TZ).strftime("%b %-d") if published.tzinfo else "Date unavailable"
        except (TypeError, ValueError):
            published_label = "Date unavailable"
        posts.append({"platform": platform, "url": row.get("url", ""),
                      "title": pdf_text((row.get("caption") or "").strip().replace("\n", " ")[:145]) or row.get("format") or "Untitled post",
                      "format": row.get("format") or "Post", "published": published_label,
                      "exposure": value, "measure": EXPOSURE.get(platform, EXPOSURE["default"])[1]})
    posts.sort(key=lambda item: item["exposure"], reverse=True)
    by_platform = {}
    for post in posts:
        by_platform[post["platform"]] = by_platform.get(post["platform"], 0) + post["exposure"]
    expected_days = (end_day - start_day).days
    complete_platform_totals = {platform: (by_platform.get(platform, 0) if platform_days.get(platform, 0) == expected_days else None)
                                for platform in ("Facebook", "Instagram", "TikTok", "Threads", "X/Twitter", "YouTube")}
    total = sum(complete_platform_totals.values()) if all(value is not None for value in complete_platform_totals.values()) else None
    return {"posts": posts, "by_platform": complete_platform_totals, "missing_days": missing_days,
            "pairs_seen": covered_pairs, "platform_days": platform_days, "expected_days": expected_days,
            "total": total, "complete_window": complete_window}


def follower_deltas(start_day, end_day):
    path = ROOT / "followers.csv"
    if not path.exists():
        return {}
    values = {}
    with path.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            if row.get("date") not in (start_day.isoformat(), end_day.isoformat()):
                continue
            key = (row.get("account", "").strip(), row.get("platform", "").strip())
            count = as_int(row.get("followers"))
            if count is not None:
                values.setdefault(key, {})[row["date"]] = count
    result = {}
    for key, dated in values.items():
        if start_day.isoformat() in dated and end_day.isoformat() in dated:
            result[key] = dated[end_day.isoformat()] - dated[start_day.isoformat()]
    return result


def latest_snapshot_date(requested=None):
    if requested:
        requested_day = date.fromisoformat(requested)
        if read_snapshot(requested_day):
            return requested_day
        if save_current_posts_snapshot(requested_day):
            return requested_day
        raise RuntimeError("No saved post snapshot exists for {} and top_posts.csv has no matching rows.".format(requested_day.isoformat()))
    today = datetime.now(TZ).date()
    if read_snapshot(today):
        return today
    if save_current_posts_snapshot(today):
        return today
    for offset in range(0, 4):
        candidate = today - timedelta(days=offset)
        if read_snapshot(candidate):
            return candidate
    raise RuntimeError("No current post snapshot could be made from today's top_posts.csv, and no recent saved snapshot was found (checked today and the prior 3 days).")


def save_current_posts_snapshot(day):
    """Create a report endpoint from today's already-collected top_posts.csv rows."""
    source = ROOT / "top_posts.csv"
    if not source.exists():
        return False
    with source.open(newline="", encoding="utf-8-sig") as stream:
        has_rows = any(row.get("snapshot", "").strip() == day.isoformat()
                       and row.get("platform") and row.get("url")
                       for row in csv.DictReader(stream))
    if not has_rows:
        return False
    # Reuse the established snapshot normalizer. This fallback is a same-day
    # collector capture; its timestamp is stored and coverage notes disclose gaps.
    from generate_daily_content_report import snapshot as save_snapshot
    save_snapshot(day, source=source)
    return read_snapshot(day) is not None


def build_report(end_day):
    start = end_day - timedelta(days=7)
    prior_start = end_day - timedelta(days=14)
    current_posts = period_posts(start, end_day)
    previous_posts = period_posts(prior_start, start)
    current_followers = follower_deltas(start, end_day)

    def audience_section(accounts, platforms):
        by_platform = {}
        for platform in platforms:
            rows = [value for (account, p), value in current_followers.items()
                    if account in accounts and p == platform]
            expected = len(accounts)
            by_platform[platform] = {"gained": sum(rows) if rows else None,
                                     "coverage": len(rows), "expected": expected}
        available = [item["gained"] for item in by_platform.values() if item["gained"] is not None]
        all_complete = all(item["coverage"] == item["expected"] for item in by_platform.values())
        return {"platforms": by_platform,
                "total": sum(available) if available and all_complete else None,
                "partial_total": sum(available) if available else None,
                "complete": all_complete,
                "observed_pairs": sum(item["coverage"] for item in by_platform.values()),
                "expected_pairs": sum(item["expected"] for item in by_platform.values())}

    main = audience_section((MAIN,), MAIN_PLATFORMS)
    subsidiaries = audience_section(SUBSIDIARIES, SUB_PLATFORMS)
    current_total = current_posts["total"]
    previous_total = previous_posts["total"]
    platform_rows = []
    for platform in ("Facebook", "Instagram", "TikTok", "Threads", "X/Twitter", "YouTube"):
        cur = current_posts["by_platform"].get(platform)
        prev = previous_posts["by_platform"].get(platform)
        platform_rows.append({"platform": platform, "measure": EXPOSURE.get(platform, EXPOSURE["default"])[1],
                              "current": cur, "previous": prev,
                              "change": cur - prev if cur is not None and prev is not None else None,
                              "change_pct": pct_change(cur, prev)})
    return {"report_date": end_day.isoformat(), "generated_at": datetime.now(TZ).isoformat(),
            "window": {"start": start.isoformat(), "end_exclusive": end_day.isoformat(),
                       "previous_start": prior_start.isoformat(), "previous_end_exclusive": start.isoformat()},
            "main_followers": main, "subsidiary_followers": subsidiaries,
            "impressions": {"platforms": platform_rows, "current_total": current_total,
                            "previous_total": previous_total,
                            "change": current_total - previous_total if current_total is not None and previous_total is not None else None,
                            "change_pct": pct_change(current_total, previous_total),
                            "current_missing_days": current_posts["missing_days"],
                            "previous_missing_days": previous_posts["missing_days"],
                            "current_pairs": current_posts["pairs_seen"], "previous_pairs": previous_posts["pairs_seen"],
                            "current_platform_days": current_posts["platform_days"],
                            "previous_platform_days": previous_posts["platform_days"],
                            "expected_days_per_period": current_posts["expected_days"],
                            "current_window_complete": current_posts["complete_window"],
                            "previous_window_complete": previous_posts["complete_window"]},
            "top_posts": current_posts["posts"][:5]}


def report_paths(end_day):
    folder = REPORTS / end_day.isoformat()
    return folder, folder / "report.json", folder / ("10K_Takes_Weekly_Analytics_" + end_day.isoformat() + ".pdf"), folder / "status.json"


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("ReportTitle", parent=base["Title"], fontName="Helvetica-Bold", fontSize=23, leading=27, textColor=NAVY, alignment=TA_LEFT, spaceAfter=5),
        "subtitle": ParagraphStyle("ReportSub", parent=base["Normal"], fontSize=9, leading=13, textColor=MUTED, spaceAfter=12),
        "section": ParagraphStyle("Section", parent=base["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=NAVY, spaceBefore=10, spaceAfter=6),
        "body": ParagraphStyle("Body", parent=base["BodyText"], fontSize=8.5, leading=11, textColor=INK),
        "small": ParagraphStyle("Small", parent=base["BodyText"], fontSize=7.2, leading=9, textColor=MUTED),
        "tablehead": ParagraphStyle("TH", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=7.5, leading=9, textColor=colors.white),
        "cell": ParagraphStyle("Cell", parent=base["BodyText"], fontSize=8, leading=10, textColor=INK),
        "cellright": ParagraphStyle("CellRight", parent=base["BodyText"], fontSize=8, leading=10, textColor=INK, alignment=TA_RIGHT),
        "kpilabel": ParagraphStyle("KpiLabel", parent=base["BodyText"], fontSize=7.3, leading=9, textColor=MUTED),
        "kpivalue": ParagraphStyle("KpiValue", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=16, leading=19, textColor=NAVY),
    }


def make_table(data, widths, header=True, font_size=8):
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY) if header else ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("GRID", (0, 0), (-1, -1), .35, RULE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, PALE]),
    ]))
    return table


def render_pdf(report, path):
    s = styles()
    doc = SimpleDocTemplate(str(path), pagesize=letter, rightMargin=.55*inch, leftMargin=.55*inch, topMargin=.48*inch, bottomMargin=.48*inch, title="10K Takes Weekly Analytics")
    story = [Paragraph("10K Takes Weekly Analytics", s["title"]),
             Paragraph("Week of {} through {} | Prepared {} | America/Chicago".format(
                 date.fromisoformat(report["window"]["start"]).strftime("%b %-d"),
                 (date.fromisoformat(report["window"]["end_exclusive"]) - timedelta(days=1)).strftime("%b %-d, %Y"),
                 datetime.fromisoformat(report["generated_at"]).strftime("%b %-d, %I:%M %p")), s["subtitle"])]

    def kpi(label, value, detail=""):
        return [Paragraph(label, s["kpilabel"]), Spacer(1, 3), Paragraph(value, s["kpivalue"]), Paragraph(detail, s["small"]) if detail else Spacer(1, 1)]

    imp = report["impressions"]
    follower_main = report["main_followers"]
    main_value = fmt(follower_main["total"] if follower_main["complete"] else follower_main["partial_total"], signed=True)
    main_hint = "All expected platform snapshots" if follower_main["complete"] else "Partial · {}/{} account-platform pairs".format(follower_main["observed_pairs"], follower_main["expected_pairs"])
    imp_hint = "Views + X impressions; tracked-post feed" if imp["current_total"] is not None else "Unavailable · incomplete post snapshots"
    kpis = Table([[kpi("MAIN FOLLOWERS GAINED", main_value, main_hint),
                   kpi("MAIN VIEWS / IMPRESSIONS", fmt(imp["current_total"]), imp_hint),
                   kpi("VS. PRIOR 7 DAYS", pct_change(imp["current_total"], imp["previous_total"]), "{} change".format(fmt(imp["change"])))]],
                 colWidths=[doc.width/3]*3)
    kpis.setStyle(TableStyle([("BACKGROUND", (0,0),(-1,-1), PALE), ("BOX",(0,0),(-1,-1),.5,RULE), ("INNERGRID",(0,0),(-1,-1),.5,RULE), ("VALIGN",(0,0),(-1,-1),"TOP"), ("LEFTPADDING",(0,0),(-1,-1),10), ("RIGHTPADDING",(0,0),(-1,-1),10), ("TOPPADDING",(0,0),(-1,-1),9), ("BOTTOMPADDING",(0,0),(-1,-1),8)]))
    lead_parts = []
    if follower_main["complete"]:
        lead_parts.append("Main account gained {} followers across the expected platforms.".format(fmt(follower_main["total"], signed=True)))
    else:
        lead_parts.append("Main account follower gain is partial: {} across {}/{} account-platform pairs.".format(fmt(follower_main["partial_total"], signed=True), follower_main["observed_pairs"], follower_main["expected_pairs"]))
    subs = report["subsidiary_followers"]
    if subs["complete"]:
        lead_parts.append("Subsidiaries gained {} followers.".format(fmt(subs["total"], signed=True)))
    else:
        lead_parts.append("Subsidiary follower gain is partial: {} across {}/{} pairs.".format(fmt(subs["partial_total"], signed=True), subs["observed_pairs"], subs["expected_pairs"]))
    if imp["current_total"] is not None and imp["previous_total"] is not None:
        lead_parts.append("Tracked views/impressions changed {} versus the previous 7 days.".format(pct_change(imp["current_total"], imp["previous_total"])))
    else:
        lead_parts.append("A complete week-over-week views/impressions comparison is not yet available in the saved snapshots.")
    if report["top_posts"]:
        top_post = report["top_posts"][0]
        lead_parts.append("Top measured post: {} on {} ({} {}).".format(html.escape(top_post["title"]), top_post["platform"], fmt(top_post["exposure"]), top_post["measure"]))
    story += [kpis, Paragraph("Weekly readout", s["section"]), Paragraph(" ".join(lead_parts), s["body"]), Paragraph("Main account followers gained", s["section"])]

    def follower_table(section, platforms, total):
        rows = [[Paragraph(x, s["tablehead"]) for x in ("Platform", "Net follower change", "Coverage")]]
        for platform in platforms:
            item = total["platforms"][platform]
            rows.append([Paragraph(platform, s["cell"]), Paragraph(fmt(item["gained"], signed=True), s["cellright"]),
                         Paragraph("{}/{} accounts".format(item["coverage"], item["expected"]), s["cellright"])])
        summary = fmt(total["total"] if total["complete"] else total["partial_total"], signed=True)
        coverage = "Complete" if total["complete"] else "Partial · {}/{} pairs".format(total["observed_pairs"], total["expected_pairs"])
        rows.append([Paragraph("TOTAL", s["cell"]), Paragraph(summary, s["cellright"]), Paragraph(coverage, s["cellright"])])
        return make_table(rows, [doc.width*.42, doc.width*.31, doc.width*.27])

    story += [follower_table("main", MAIN_PLATFORMS, follower_main),
              Paragraph("Subsidiary account followers gained", s["section"]),
              follower_table("subs", SUB_PLATFORMS, report["subsidiary_followers"]), PageBreak(),
              Paragraph("Main account views and impressions", s["section"]),
              Paragraph("Total combines native platform counters (views on most platforms and impressions on X). Figures are changes in tracked post counters, not a complete account-wide platform insight total.", s["small"]), Spacer(1, 5)]
    imp_rows = [[Paragraph(x, s["tablehead"]) for x in ("Platform", "Measure", "Last 7 days", "Prior 7 days", "Change", "% change")]]
    for row in imp["platforms"]:
        imp_rows.append([Paragraph(row["platform"], s["cell"]), Paragraph(row["measure"], s["cell"]),
                         Paragraph(fmt(row["current"]), s["cellright"]), Paragraph(fmt(row["previous"]), s["cellright"]),
                         Paragraph(fmt(row["change"]), s["cellright"]), Paragraph(row["change_pct"], s["cellright"])])
    imp_rows.append([Paragraph("TOTAL", s["cell"]), Paragraph("Mixed native measures", s["small"]),
                     Paragraph(fmt(imp["current_total"]), s["cellright"]), Paragraph(fmt(imp["previous_total"]), s["cellright"]),
                     Paragraph(fmt(imp["change"]), s["cellright"]), Paragraph(imp["change_pct"], s["cellright"])])
    story += [make_table(imp_rows, [doc.width*.18, doc.width*.15, doc.width*.17, doc.width*.17, doc.width*.16, doc.width*.17]),
              Paragraph("Top 5 posts across platforms", s["section"])]
    top = report["top_posts"]
    top_rows = [[Paragraph(x, s["tablehead"]) for x in ("#", "Post", "Platform", "Weekly views / impressions")]]
    for index, post in enumerate(top, 1):
        label = "{} · {} · {}".format(post["published"], post["format"], html.escape(post["title"]))
        if post.get("url", "").startswith(("https://", "http://")):
            label = '<link href="{}" color="#1687c9">{}</link>'.format(html.escape(post["url"], quote=True), label)
        top_rows.append([Paragraph(str(index), s["cell"]), Paragraph(label, s["cell"]),
                         Paragraph(post["platform"], s["cell"]), Paragraph("{} {}".format(fmt(post["exposure"]), post["measure"]), s["cellright"])])
    if not top:
        top_rows.append([Paragraph("-", s["cell"]), Paragraph("No post counters could be compared across the reporting window.", s["cell"]), Paragraph("-", s["cell"]), Paragraph("Unavailable", s["cellright"])])
    story += [make_table(top_rows, [doc.width*.06, doc.width*.56, doc.width*.17, doc.width*.21]), Spacer(1, 6)]
    notes = ["Follower changes compare the saved account snapshots on the period start and end dates. Coverage shows how many expected account-platform pairs had both readings.",
             "Post activity is summed from consecutive midnight snapshots. Missing snapshots or reset counters are not counted as zero. Feeds contain a limited recent-post set, so older posts may be outside coverage.",
             "Views and X impressions are different native measures; platform totals are shown separately. The combined total is a convenience sum, not a standardized cross-platform metric."]
    missing = sorted(set(imp["current_missing_days"] + imp["previous_missing_days"]))
    if missing:
        notes.append("Missing midnight snapshot pairs: " + ", ".join(missing) + ".")
    if not imp["current_window_complete"]:
        notes.append("The top-five weekly post ranking is unavailable because the current seven-day capture window is incomplete.")
    story += [Paragraph("Data notes", s["section"])]
    story.extend(Paragraph("• " + note, s["small"]) for note in notes)

    def footer(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(RULE)
        canvas.line(document.leftMargin, .34*inch, letter[0]-document.rightMargin, .34*inch)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(document.leftMargin, .21*inch, "10K Takes · Weekly Analytics")
        canvas.drawRightString(letter[0]-document.rightMargin, .21*inch, "Page {}".format(document.page))
        canvas.restoreState()
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def generate(end_day, force=False):
    folder, json_path, pdf_path, _ = report_paths(end_day)
    folder.mkdir(parents=True, exist_ok=True)
    if json_path.exists() and not force:
        report = json.loads(json_path.read_text(encoding="utf-8"))
    else:
        report = build_report(end_day)
        json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    render_pdf(report, pdf_path)
    print("Weekly report generated: {}".format(pdf_path))
    return report


def deliver(end_day, authorized_resend=False):
    folder, json_path, pdf_path, status_path = report_paths(end_day)
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {"state": "ready"}
    if status.get("state") == "sent" and not authorized_resend:
        print("Already sent; duplicate delivery prevented.")
        return
    if status.get("state") in ("sending", "delivery_unknown") and not authorized_resend:
        raise RuntimeError("Delivery status is ambiguous; check Resend before authorizing a resend.")
    key = os.environ.get("RESEND_API_KEY", "").strip()
    sender = os.environ.get("RESEND_FROM", "").strip()
    recipient = (os.environ.get("WEEKLY_CONTENT_REPORT_TO", "").strip()
                 or os.environ.get("DAILY_CONTENT_REPORT_TO", "").strip()
                 or "10000takes@gmail.com")
    if not key or not sender:
        raise RuntimeError("RESEND_API_KEY and RESEND_FROM are required to email the weekly report.")
    if not pdf_path.exists() or not json_path.exists():
        raise RuntimeError("Generate the weekly report before sending it.")
    report = json.loads(json_path.read_text(encoding="utf-8"))
    attempt = int(status.get("attempt", 0)) + 1
    status.update({"state": "sending", "attempt": attempt, "updated_at": datetime.now(timezone.utc).isoformat()})
    status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    span = date.fromisoformat(report["window"]["start"]).strftime("%b %-d") + " - " + (end_day - timedelta(days=1)).strftime("%b %-d, %Y")
    payload = {"from": sender, "to": [email.strip() for email in recipient.split(",") if email.strip()],
               "subject": "10K Takes Weekly Analytics - " + span,
               "text": "Attached is the 10K Takes weekly analytics report for {}. It summarizes follower changes, tracked post views/impressions, week-over-week comparison, and the top five measured posts. Coverage gaps are called out in the report.".format(span),
               "attachments": [{"filename": pdf_path.name, "content": base64.b64encode(pdf_path.read_bytes()).decode("ascii")} ]}
    request = urllib.request.Request("https://api.resend.com/emails", data=json.dumps(payload).encode(),
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                              "Idempotency-Key": "10k-weekly-analytics-{}-{}".format(end_day.isoformat(), attempt if authorized_resend else 1)}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            body = json.loads(response.read().decode("utf-8"))
        status.update({"state": "sent", "email_id": body.get("id"), "updated_at": datetime.now(timezone.utc).isoformat()})
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print("Weekly report emailed to {}.".format(recipient))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:400]
        status.update({"state": "delivery_failed", "error": "Resend HTTP {}: {}".format(error.code, detail), "updated_at": datetime.now(timezone.utc).isoformat()})
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        raise RuntimeError("Resend rejected weekly report (HTTP {}).".format(error.code))
    except (urllib.error.URLError, TimeoutError) as error:
        status.update({"state": "delivery_unknown", "error": str(error)[:300], "updated_at": datetime.now(timezone.utc).isoformat()})
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        raise RuntimeError("Weekly email delivery status is unknown; check Resend before retrying.")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    generate_parser = sub.add_parser("generate")
    generate_parser.add_argument("--date", help="End-capture date (YYYY-MM-DD); period is the 7 days ending at this date")
    generate_parser.add_argument("--force", action="store_true")
    deliver_parser = sub.add_parser("deliver")
    deliver_parser.add_argument("--date", help="End-capture date (YYYY-MM-DD)")
    deliver_parser.add_argument("--authorized-resend", action="store_true")
    args = parser.parse_args()
    end_day = date.fromisoformat(args.date) if args.date else latest_snapshot_date()
    if args.command == "generate":
        generate(end_day, args.force)
    else:
        deliver(end_day, args.authorized_resend)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit("Weekly analytics report failed: {}".format(error))
