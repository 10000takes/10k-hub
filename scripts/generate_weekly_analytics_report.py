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
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (Flowable, HRFlowable, Image, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle,
                                PageBreak)

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


def latest_follower_date(report_day):
    path = ROOT / "followers.csv"
    if not path.exists():
        return None
    dates = []
    with path.open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            try:
                captured = date.fromisoformat(row.get("date", ""))
            except ValueError:
                continue
            if captured <= report_day:
                dates.append(captured)
    if not dates:
        return None
    latest = max(dates)
    return latest if (report_day - latest).days <= 1 else None


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


def weekly_rolling_metrics(report_day):
    """Compare saved rolling 7-day account metrics with the same reading 7 days earlier."""
    path = ROOT / "metrics.csv"
    series = {}
    if path.exists():
        with path.open(newline="", encoding="utf-8-sig") as stream:
            for row in csv.DictReader(stream):
                if row.get("account", "").strip() != MAIN or row.get("metric", "").strip() != "views_7d":
                    continue
                platform = row.get("platform", "").strip()
                try:
                    captured = date.fromisoformat(row.get("date", ""))
                except ValueError:
                    continue
                value = as_int(row.get("value"))
                if value is not None and captured <= report_day:
                    series.setdefault(platform, {})[captured] = value

    rows = []
    for platform in MAIN_PLATFORMS:
        dated = series.get(platform, {})
        current_date = max((d for d in dated if (report_day - d).days <= 1), default=None)
        current = dated.get(current_date) if current_date else None
        previous_date = current_date - timedelta(days=7) if current_date else None
        previous = dated.get(previous_date) if previous_date else None
        rows.append({"platform": platform,
                     "measure": "impressions" if platform == "X/Twitter" else "views",
                     "current": current, "previous": previous,
                     "current_date": current_date.isoformat() if current_date else None,
                     "previous_date": previous_date.isoformat() if previous_date else None,
                     "change": current - previous if current is not None and previous is not None else None,
                     "change_pct": pct_change(current, previous)})
    comparable = [row for row in rows if row["current"] is not None and row["previous"] is not None]
    current_total = sum(row["current"] for row in comparable) if comparable else None
    previous_total = sum(row["previous"] for row in comparable) if comparable else None
    return {"platforms": rows, "current_total": current_total, "previous_total": previous_total,
            "change": current_total - previous_total if current_total is not None and previous_total is not None else None,
            "change_pct": pct_change(current_total, previous_total), "coverage": len(comparable),
            "expected_platforms": len(MAIN_PLATFORMS),
            "current_dates": sorted({row["current_date"] for row in comparable if row["current_date"]}),
            "missing_platforms": [row["platform"] for row in rows if row["current"] is None or row["previous"] is None]}


def top_posts_for_week(start_day, end_day):
    snapshot_day = end_day
    snapshot = read_snapshot(snapshot_day)
    if not snapshot or not snapshot["posts"]:
        snapshot = None
        for offset in range(0, 3):
            candidate = end_day - timedelta(days=offset)
            candidate_snapshot = read_snapshot(candidate)
            if not candidate_snapshot or not candidate_snapshot["posts"]:
                save_current_posts_snapshot(candidate)
            candidate_snapshot = read_snapshot(candidate)
            if candidate_snapshot and candidate_snapshot["posts"]:
                snapshot_day, snapshot = candidate, candidate_snapshot
                break
    if not snapshot:
        return []
    ranked = []
    for row in snapshot["posts"]:
        try:
            posted = datetime.fromisoformat(str(row.get("posted_at", "")).replace("Z", "+00:00"))
            if posted.tzinfo is None:
                continue
            posted_date = posted.astimezone(TZ).date()
        except (TypeError, ValueError):
            continue
        if not (start_day <= posted_date < end_day):
            continue
        count = exposure_value(row)
        if count is None:
            continue
        platform = row.get("platform", "Unknown")
        ranked.append({"platform": platform, "url": row.get("url", ""),
                       "title": pdf_text((row.get("caption") or "").strip().replace("\n", " ")[:145]) or row.get("format") or "Untitled post",
                       "format": row.get("format") or "Post",
                       "published": posted.astimezone(TZ).strftime("%b %-d"),
                       "captured": snapshot_day.isoformat(),
                       "exposure": count, "measure": EXPOSURE.get(platform, EXPOSURE["default"])[1]})
    ranked.sort(key=lambda item: item["exposure"], reverse=True)
    return ranked[:5]


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
        if save_current_posts_snapshot(candidate):
            return candidate
    raise RuntimeError("No current post snapshot could be made from today's top_posts.csv, and no recent saved snapshot was found (checked today and the prior 3 days).")


def save_current_posts_snapshot(day):
    """Create a report endpoint from the matching dated rows already in top_posts.csv."""
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
    follower_end = latest_follower_date(end_day)
    follower_start = follower_end - timedelta(days=7) if follower_end else None
    current_followers = follower_deltas(follower_start, follower_end) if follower_start else {}

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
    subsidiaries_by_account = []
    for account in SUBSIDIARIES:
        platforms = {platform: current_followers.get((account, platform))
                     for platform in SUB_PLATFORMS}
        available = [value for value in platforms.values() if value is not None]
        complete = len(available) == len(SUB_PLATFORMS)
        subsidiaries_by_account.append({
            "account": account, "platforms": platforms,
            "total": sum(available) if complete else None,
            "partial_total": sum(available) if available else None,
            "coverage": len(available), "expected": len(SUB_PLATFORMS),
            "complete": complete,
        })
    impressions = weekly_rolling_metrics(end_day)
    return {"report_date": end_day.isoformat(), "generated_at": datetime.now(TZ).isoformat(),
            "window": {"start": start.isoformat(), "end_exclusive": end_day.isoformat(),
                       "previous_start": prior_start.isoformat(), "previous_end_exclusive": start.isoformat()},
            "follower_window": {"start": follower_start.isoformat() if follower_start else None,
                                "end": follower_end.isoformat() if follower_end else None},
            "main_followers": main, "subsidiary_followers": subsidiaries,
            "subsidiaries_by_account": subsidiaries_by_account,
            "impressions": impressions,
            "top_posts": top_posts_for_week(start, end_day)}


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
        "cellbold": ParagraphStyle("CellBold", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=INK),
        "cellrightbold": ParagraphStyle("CellRightBold", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=INK, alignment=TA_RIGHT),
        "smallbold": ParagraphStyle("SmallBold", parent=base["BodyText"], fontName="Helvetica-Bold", fontSize=7.2, leading=9, textColor=MUTED),
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


class PlatformStatusLabel(Flowable):
    """Draw a status mark and platform label without relying on symbol fonts."""
    def __init__(self, label, available, text_color=colors.white):
        super().__init__()
        self.label = label
        self.available = available
        self.text_color = text_color
        self.width = 12 + stringWidth(label, "Helvetica", 7.5)
        self.height = 11

    def wrap(self, avail_width, avail_height):
        return min(self.width, avail_width), self.height

    def draw(self):
        c = self.canv
        c.setStrokeColor(GREEN if self.available else colors.HexColor("#d94a4a"))
        c.setLineWidth(1.3)
        if self.available:
            c.line(0, 4, 2.5, 1.5)
            c.line(2.5, 1.5, 7, 7)
        else:
            c.line(0, 1.5, 6, 7.5)
            c.line(0, 7.5, 6, 1.5)
        c.setFont("Helvetica", 7.5)
        c.setFillColor(self.text_color)
        c.drawString(11, 2, self.label)


def section_rule():
    return [Spacer(1, 7), HRFlowable(width="100%", thickness=.45,
                                    color=RULE, spaceBefore=0, spaceAfter=0), Spacer(1, 7)]


def render_pdf(report, path):
    s = styles()
    doc = SimpleDocTemplate(str(path), pagesize=letter, rightMargin=.55*inch, leftMargin=.55*inch, topMargin=.48*inch, bottomMargin=.48*inch, title="10K Takes Weekly Analytics")
    logo = Image(str(ROOT / "assets" / "10k-takes-logo-red.png"), width=.48*inch, height=.48*inch)
    report_heading = [Paragraph("10K Takes Weekly Analytics", s["title"]),
             Paragraph("Week of {} through {} | Prepared {} | America/Chicago".format(
                 date.fromisoformat(report["window"]["start"]).strftime("%b %-d"),
                 (date.fromisoformat(report["window"]["end_exclusive"]) - timedelta(days=1)).strftime("%b %-d, %Y"),
                 datetime.fromisoformat(report["generated_at"]).strftime("%b %-d, %I:%M %p")), s["subtitle"])]
    header = Table([[logo, report_heading]], colWidths=[.62*inch, doc.width-.62*inch], hAlign="LEFT")
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                                ("TOPPADDING", (0, 0), (-1, -1), 0),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 0)]))
    story = [header, Spacer(1, 3)]

    def kpi(label, value, detail=""):
        return [Paragraph(label, s["kpilabel"]), Spacer(1, 3), Paragraph(value, s["kpivalue"]), Paragraph(detail, s["small"]) if detail else Spacer(1, 1)]

    imp = report["impressions"]
    follower_main = report["main_followers"]
    main_value = fmt(follower_main["total"] if follower_main["complete"] else follower_main["partial_total"], signed=True)
    main_hint = "All expected platform snapshots" if follower_main["complete"] else "Partial · {}/{} account-platform pairs".format(follower_main["observed_pairs"], follower_main["expected_pairs"])
    imp_hint = "Rolling 7-day measures · {}/{} platforms".format(imp["coverage"], imp["expected_platforms"]) if imp["current_total"] is not None else "Unavailable · no comparable platform readings"
    kpis = Table([[kpi("Main Followers Gained", main_value, main_hint),
                   kpi("Main Views / Impressions", fmt(imp["current_total"]), imp_hint),
                   kpi("Vs. Prior 7 Days", pct_change(imp["current_total"], imp["previous_total"]), "{} change".format(fmt(imp["change"])))]],
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
        lead_parts.append("Views/impressions changed {} versus the previous 7 days across {}/{} comparable platforms.".format(pct_change(imp["current_total"], imp["previous_total"]), imp["coverage"], imp["expected_platforms"]))
    else:
        lead_parts.append("A comparable week-over-week views/impressions reading is not available yet.")
    if report["top_posts"]:
        top_post = report["top_posts"][0]
        lead_parts.append("Top measured post: {} on {} ({} {}).".format(html.escape(top_post["title"]), top_post["platform"], fmt(top_post["exposure"]), top_post["measure"]))
    story += [kpis, Paragraph("Weekly Readout", s["section"]), Paragraph(" ".join(lead_parts), s["body"])]
    story.extend(section_rule())
    story.append(Paragraph("Main Account Followers Gained", s["section"]))

    def follower_table(section, platforms, total):
        rows = [[Paragraph("Platform", s["tablehead"]),
                 Paragraph("Net Follower Change", s["tablehead"])]]
        for platform in platforms:
            item = total["platforms"][platform]
            rows.append([PlatformStatusLabel(platform, item["coverage"] == item["expected"], INK),
                         Paragraph(fmt(item["gained"], signed=True), s["cellright"])])
        summary = fmt(total["total"] if total["complete"] else total["partial_total"], signed=True)
        coverage = "Complete" if total["complete"] else "Partial · {}/{} pairs".format(total["observed_pairs"], total["expected_pairs"])
        rows.append([Paragraph("Total · " + coverage, s["cellbold"]), Paragraph(summary, s["cellrightbold"])])
        return make_table(rows, [doc.width*.68, doc.width*.32])

    follower_range = "Follower count comparison: {} to {} (latest saved readings).".format(
        date.fromisoformat(report["follower_window"]["start"]).strftime("%b %-d"),
        date.fromisoformat(report["follower_window"]["end"]).strftime("%b %-d, %Y")) if report["follower_window"]["start"] else "Follower count readings for a 7-day comparison are unavailable."
    story += [Paragraph(follower_range, s["small"]), follower_table("main", MAIN_PLATFORMS, follower_main)]
    story.extend(section_rule())
    story.append(Paragraph("Subsidiary Followers Gained By Account", s["section"]))
    account_rows = [[Paragraph("Account", s["tablehead"]), Paragraph("Total", s["tablehead"])] +
                    [PlatformStatusLabel(platform,
                         report["subsidiary_followers"]["platforms"][platform]["coverage"] ==
                         report["subsidiary_followers"]["platforms"][platform]["expected"])
                     for platform in SUB_PLATFORMS]]
    for account in report.get("subsidiaries_by_account", []):
        total = account["total"] if account["complete"] else account["partial_total"]
        account_rows.append([Paragraph(account["account"], s["cell"]),
                             Paragraph(fmt(total, signed=True), s["cellright"])] +
                            [Paragraph(fmt(account["platforms"].get(platform), signed=True), s["cellright"])
                             for platform in SUB_PLATFORMS] +
                            [])
    subsidiary_total = report["subsidiary_followers"]
    account_rows.append([Paragraph("All Subsidiaries", s["cellbold"]),
                         Paragraph(fmt(subsidiary_total["total"] if subsidiary_total["complete"] else subsidiary_total["partial_total"], signed=True), s["cellrightbold"])] +
                        [Paragraph(fmt(subsidiary_total["platforms"][platform]["gained"], signed=True), s["cellrightbold"])
                         for platform in SUB_PLATFORMS] +
                        [])
    account_widths = [doc.width*.22, doc.width*.12] + [doc.width*.132]*5
    story += [make_table(account_rows, account_widths)]
    story.extend(section_rule())
    story += [PageBreak(), Paragraph("Main Account Views And Impressions", s["section"]),
              Paragraph("Each value is the platform's saved rolling 7-day views metric (impressions for X), compared with that platform's reading from seven days earlier. The total is a convenience sum of native metrics; coverage is shown because platform definitions differ.", s["small"]), Spacer(1, 5)]
    imp_rows = [[Paragraph(x, s["tablehead"]) for x in ("Platform", "Measure", "Last 7 Days", "Prior 7 Days", "Change", "% Change")]]
    for row in imp["platforms"]:
        imp_rows.append([Paragraph(row["platform"], s["cell"]), Paragraph(row["measure"], s["cell"]),
                         Paragraph(fmt(row["current"]), s["cellright"]), Paragraph(fmt(row["previous"]), s["cellright"]),
                         Paragraph(fmt(row["change"]), s["cellright"]), Paragraph(row["change_pct"], s["cellright"])])
    imp_rows.append([Paragraph("Total", s["cellbold"]), Paragraph("Mixed Native Measures", s["smallbold"]),
                     Paragraph(fmt(imp["current_total"]), s["cellrightbold"]), Paragraph(fmt(imp["previous_total"]), s["cellrightbold"]),
                     Paragraph(fmt(imp["change"]), s["cellrightbold"]), Paragraph(imp["change_pct"], s["cellrightbold"])])
    story += [make_table(imp_rows, [doc.width*.18, doc.width*.15, doc.width*.17, doc.width*.17, doc.width*.16, doc.width*.17])]
    story.extend(section_rule())
    story.append(Paragraph("Top 5 Posts Across Platforms", s["section"]))
    top = report["top_posts"]
    top_rows = [[Paragraph(x, s["tablehead"]) for x in ("#", "Post", "Platform", "Views / Impressions At Capture")]]
    for index, post in enumerate(top, 1):
        label = "{} · {} · {}".format(post["published"], post["format"], html.escape(post["title"]))
        if post.get("url", "").startswith(("https://", "http://")):
            label = '<link href="{}" color="#1687c9">{}</link>'.format(html.escape(post["url"], quote=True), label)
        top_rows.append([Paragraph(str(index), s["cell"]), Paragraph(label, s["cell"]),
                         Paragraph(post["platform"], s["cell"]), Paragraph("{} {}".format(fmt(post["exposure"]), post["measure"]), s["cellright"])])
    if not top:
        top_rows.append([Paragraph("-", s["cell"]), Paragraph("No posts published in the reporting window had a usable counter in the latest saved post snapshot.", s["cell"]), Paragraph("-", s["cell"]), Paragraph("Unavailable", s["cellright"])])
    story += [make_table(top_rows, [doc.width*.06, doc.width*.56, doc.width*.17, doc.width*.21])]
    story.extend(section_rule())
    top_capture = report["top_posts"][0].get("captured") if report["top_posts"] else None
    notes = ["Follower changes compare saved counts 7 days apart. The capture dates are shown above; stale or missing account-platform pairs are unavailable, not zero.",
             "Top posts are posts published during the reporting week, ranked by their cumulative view or impression counters at the latest saved capture{}. The posts have different ages, so these are not equal-age comparisons.".format(" on " + top_capture if top_capture else ""),
             "Views and X impressions are different native measures. The combined total is a convenience sum, not a standardized cross-platform metric."]
    if imp["current_dates"]:
        notes.append("Comparable rolling-metric captures: {}. Missing or stale platforms: {}.".format(", ".join(imp["current_dates"]), ", ".join(imp["missing_platforms"]) if imp["missing_platforms"] else "none"))
    elif imp["missing_platforms"]:
        notes.append("No comparable rolling-metric pairs were available. Missing or stale platforms: {}.".format(", ".join(imp["missing_platforms"])))
    story += [Paragraph("Data Notes", s["section"])]
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
    if not read_snapshot(end_day):
        save_current_posts_snapshot(end_day)
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
