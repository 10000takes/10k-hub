#!/usr/bin/env python3
"""Build a saved, evidence-only two-page 10K Takes daily content report."""
import argparse
import base64
import csv
import json
import os
import statistics
import sys
import time as time_module
import urllib.error
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / ".github" / "content-report-data"
SNAPSHOTS = STATE / "snapshots"
REPORTS = STATE / "reports"
TZ = ZoneInfo("America/Chicago")
PLATFORMS = ("Instagram", "Facebook", "TikTok", "X/Twitter", "YouTube", "Threads")
MEASUREMENTS = {
    "Instagram": "views", "Facebook": "views", "TikTok": "views",
    "X/Twitter": "impressions", "YouTube": "views", "Threads": "views",
}
METRICS = ("views", "likes", "comments", "shares", "saves")


def reporting_date(now=None):
    """Previous calendar date in Chicago, including DST transitions."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(TZ).date() - timedelta(days=1)


def reporting_window(day):
    start = datetime.combine(day, time.min, TZ)
    end = datetime.combine(day + timedelta(days=1), time.min, TZ)
    return start, end


def local_post_date(posted):
    try:
        value = datetime.fromisoformat(str(posted).replace("Z", "+00:00"))
        if value.tzinfo is None:
            return None
        return value.astimezone(TZ).date()
    except (TypeError, ValueError):
        return None


def counter_delta(current, previous):
    if current is None or previous is None or current < previous:
        return None
    return current - previous


def read_snapshot(day):
    path = SNAPSHOTS / (day.isoformat() + ".json")
    if not path.exists():
        return None
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("snapshot_date") != day.isoformat() or not isinstance(value.get("posts"), list):
        raise ValueError("Invalid saved snapshot: " + str(path))
    return value


def post_key(row):
    return (str(row.get("platform", "")).casefold(), str(row.get("url", "")).rstrip("/"))


def platform_deltas(before, after):
    """Per-platform changes for posts present and valid in both daily captures."""
    prior = {post_key(row): row for row in before.get("posts", [])}
    totals = {}
    post_changes = {}
    for row in after.get("posts", []):
        old = prior.get(post_key(row))
        if not old:
            continue
        platform = row.get("platform")
        exposure = "views" if platform != "X/Twitter" else "views"
        delta = counter_delta(as_int(row.get(exposure)), as_int(old.get(exposure)))
        if delta is None:
            continue
        totals[platform] = totals.get(platform, 0) + delta
        post_changes[post_key(row)] = delta
    return totals, post_changes


def as_int(value):
    try:
        if value is None or value == "":
            return None
        number = int(value)
        return number if number >= 0 else None
    except (TypeError, ValueError):
        return None


def historical_baselines(day, current_snapshot):
    """Median platform daily tracked-post changes; require >=7 measured days."""
    by_platform = {platform: [] for platform in PLATFORMS}
    for offset in range(1, 29):
        start_day = day - timedelta(days=offset)
        end_day = start_day + timedelta(days=1)
        before, after = read_snapshot(start_day), read_snapshot(end_day)
        if not before or not after:
            continue
        # Do not treat a platform's stale/missing rows as a zero observation.
        totals, _ = platform_deltas(before, after)
        for platform, value in totals.items():
            by_platform.setdefault(platform, []).append(value)
    return {platform: {"median": statistics.median(values) if len(values) >= 7 else None,
                       "days": len(values), "method": "median of daily changes in tracked-post counters"}
            for platform, values in by_platform.items()}


def build_report(day, before, after, generated_at=None):
    start, end = reporting_window(day)
    generated_at = generated_at or datetime.now(TZ)
    actual_window = {
        "reporting_start": start.isoformat(), "reporting_end_exclusive": end.isoformat(),
        "start_capture": before.get("captured_at") if before else None,
        "end_capture": after.get("captured_at") if after else None,
    }
    daily_totals, changes = platform_deltas(before, after) if before and after else ({}, {})
    previous_rows = {post_key(r): r for r in (before or {}).get("posts", [])}
    end_rows = {post_key(r): r for r in (after or {}).get("posts", [])}
    cohort = []
    for key, row in end_rows.items():
        if local_post_date(row.get("posted_at")) != day:
            continue
        prior = previous_rows.get(key)
        # A post published during D has no start-of-day counter. Its cumulative
        # lifetime counters at the next-morning capture therefore represent
        # activity since publication, with the short capture delay disclosed.
        exposure = as_int(row.get("views"))
        interaction_values = [as_int(row.get(metric)) for metric in ("likes", "comments", "shares", "saves")]
        interactions = sum(interaction_values) if all(v is not None for v in interaction_values) else None
        cohort.append({
            "platform": row.get("platform", ""), "url": row.get("url", ""),
            "title": (row.get("caption") or "").strip()[:100] or row.get("type") or "Untitled post",
            "format": row.get("type") or "Post", "posted_at": row.get("posted_at", ""),
            "exposure": exposure, "exposure_label": MEASUREMENTS.get(row.get("platform"), "views"),
            "engagements": interactions,
            "evidence": "Cumulative post counters at the next-morning capture; as this post was published on the reporting date, its totals accrued after publication. Capture may include a brief delay past midnight.",
        })
    cohort.sort(key=lambda r: (r["exposure"] is None, -(r["exposure"] or 0)))
    baselines = historical_baselines(day, after) if after else {}
    covered = sorted({r.get("platform") for r in (after or {}).get("posts", []) if r.get("platform")})
    platform_rows = []
    for platform in PLATFORMS:
        measured = platform in daily_totals
        baseline = baselines.get(platform, {}).get("median")
        observed = daily_totals.get(platform) if measured else None
        delta_pct = ((observed - baseline) / baseline * 100) if baseline and observed is not None else None
        platform_rows.append({
            "platform": platform, "measure": MEASUREMENTS[platform],
            "observed": observed, "baseline": baseline, "delta_percent": delta_pct,
            "baseline_days": baselines.get(platform, {}).get("days", 0),
            "posts_measured": sum(1 for key in changes if key[0] == platform.casefold()),
            "signal": ("No matching post counters in both snapshots" if not measured else
                       "Tracked-post counter change; not an account-wide total"),
        })
    measured_cohort = [post for post in cohort if post["exposure"] is not None]
    unmeasured_cohort = [post for post in cohort if post["exposure"] is None]
    selected_cohort = measured_cohort[:3]
    for post in reversed(measured_cohort[-3:]):
        if post not in selected_cohort:
            selected_cohort.append(post)
    selected_cohort.extend(unmeasured_cohort[:max(0, 6 - len(selected_cohort))])
    notes = []
    if not before or not after:
        notes.append("One or both midnight snapshots are missing; daily activity cannot be measured yet.")
    notes.append("Collectors sample posts shortly after midnight. Reported changes are capture-to-capture deltas; counters may include a short collection delay around midnight.")
    notes.append("The post feed covers a limited recent-post set (up to each platform collector's API limit and roughly 30 days). It does not include older posts, so an all-post account impression total is unavailable.")
    notes.append("Views and X impressions are different platform measures and are compared only within their platform.")
    if any(row["baseline"] is None for row in platform_rows):
        notes.append("Platform baselines require at least 7 valid historical daily comparisons; missing or stale days are not counted as zero.")
    data = {
        "reporting_date": day.isoformat(), "generated_at": generated_at.isoformat(),
        "timezone": "America/Chicago", "window": actual_window,
        "publication_cohort_count": len(cohort), "covered_platform_count": len(covered),
        "covered_platforms": covered, "all_account_impressions": None,
        "score": None, "platforms": platform_rows,
        "publication_cohort": selected_cohort[:6], "publication_cohort_total": len(cohort),
        "measurement_notes": notes,
    }
    data["diagnosis"] = diagnosis(data)
    data["actions"] = recommendations(data, end_rows, changes)
    data["confidence"] = confidence_text(data)
    return data


def diagnosis(report):
    measured = [p for p in report["platforms"] if p["observed"] is not None]
    if not measured:
        return "A verified yesterday-only diagnosis is not available yet because matching post snapshots are missing. The report does not substitute lifetime counters or estimated account totals."
    above = [p for p in measured if p["delta_percent"] is not None and p["delta_percent"] > 0]
    below = [p for p in measured if p["delta_percent"] is not None and p["delta_percent"] < 0]
    coverage = "Observed post activity is available for " + ", ".join(p["platform"] for p in measured) + "."
    if above or below:
        labels = []
        if above: labels.append("above its own historical median on " + ", ".join(p["platform"] for p in above))
        if below: labels.append("below its own historical median on " + ", ".join(p["platform"] for p in below))
        return coverage + " Measured tracked-post activity was " + " and ".join(labels) + ". These comparisons describe observed counters, not causes or algorithmic distribution."
    return coverage + " Historical comparisons are still unavailable or insufficient. The available data cannot establish why posts performed as they did."


def recommendations(report, end_rows, changes):
    rows = report["publication_cohort"]
    actions = []
    supported = [r for r in rows if r["exposure"] is not None]
    if supported:
        best = supported[0]
        actions.append("Review the " + best["format"] + " post on " + best["platform"] + " (" + fmt(best["exposure"]) + " tracked " + best["exposure_label"] + " during the capture window) and decide whether its creative is suitable to repurpose today.")
    else:
        actions.append("Before repeating yesterday's creative, open its platform insights and record the reporting-window metrics; no publication-cohort counter delta is available yet.")
    measured = [p for p in report["platforms"] if p["delta_percent"] is not None]
    if measured:
        low = min(measured, key=lambda p: p["delta_percent"])
        actions.append("For the next " + low["platform"] + " post, test one alternate opening or format and compare it with the platform's " + str(low["baseline_days"]) + "-day tracked-post median; yesterday was " + pct(low["delta_percent"]) + " versus that comparator.")
    else:
        actions.append("Collect a complete daily snapshot series for at least 7 days before ranking platform performance; keep the first comparison within each platform.")
    actions.append("Log post type, hook, topic, length, and any paid boost for each new post today so future recommendations can separate observed patterns from missing context.")
    return actions[:3]


def confidence_text(report):
    measured = sum(p["observed"] is not None for p in report["platforms"])
    baseline = sum(p["baseline"] is not None for p in report["platforms"])
    return ("High confidence: reporting-date boundaries and publication dates are assigned in America/Chicago. "
            "Moderate confidence: counter changes for posts present in both snapshots; platform API counters can arrive late. "
            + ("Historical comparisons are available for " + str(baseline) + " platform(s). " if baseline else "Historical comparisons are not available until at least 7 valid daily pairs exist. ")
            + "Low confidence: whole-account impressions, older posts outside the collector window, unsupported metrics, and causal explanations. "
            + str(measured) + " platform(s) had measurable tracked-post changes.")


def fmt(value):
    return "Not available" if value is None else format(int(value), ",")


def pct(value):
    return "Not available" if value is None else ("+" if value >= 0 else "") + format(value, ".0f") + "%"


def report_paths(day):
    directory = REPORTS / day.isoformat()
    return directory, directory / "report.json", directory / ("10K_Takes_Daily_Content_Report_" + day.isoformat() + ".pdf"), directory / "status.json"


def load_or_create(day, force=False):
    directory, json_path, pdf_path, status_path = report_paths(day)
    directory.mkdir(parents=True, exist_ok=True)
    if json_path.exists() and not force:
        report = json.loads(json_path.read_text(encoding="utf-8"))
    else:
        before, after = read_snapshot(day), read_snapshot(day + timedelta(days=1))
        report = build_report(day, before, after)
        json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        status_path.write_text(json.dumps({"reporting_date": day.isoformat(), "state": "ready", "updated_at": datetime.now(timezone.utc).isoformat()}, indent=2) + "\n", encoding="utf-8")
    render_pdf(report, pdf_path)
    return report, json_path, pdf_path, status_path


def paragraph(text, style):
    from xml.sax.saxutils import escape
    from reportlab.platypus import Paragraph
    return Paragraph(escape(str(text)).replace("\n", "<br/>"), style)


def render_pdf(report, output):
    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_LEFT, TA_RIGHT
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate,
                                        Image, Paragraph, Spacer, Table, TableStyle)
    except ImportError as error:
        raise RuntimeError("PDF generation requires reportlab; install it with python -m pip install reportlab") from error

    navy, ink, muted, pale, line = colors.HexColor("#14243B"), colors.HexColor("#182536"), colors.HexColor("#566B86"), colors.HexColor("#F0F4FA"), colors.HexColor("#CED8E6")
    styles = getSampleStyleSheet()
    kicker = ParagraphStyle("Kicker", parent=styles["Normal"], fontName="Helvetica", fontSize=9, leading=11, textColor=muted, spaceAfter=3)
    title = ParagraphStyle("Title", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=navy, spaceAfter=4)
    date_style = ParagraphStyle("Date", parent=styles["Normal"], fontName="Helvetica", fontSize=12, leading=16, textColor=navy, spaceAfter=12)
    section = ParagraphStyle("Section", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=navy, spaceBefore=9, spaceAfter=6)
    body = ParagraphStyle("Body", parent=styles["BodyText"], fontName="Helvetica", fontSize=11, leading=15, textColor=ink, spaceAfter=4)
    small = ParagraphStyle("Small", parent=body, fontSize=9, leading=12, textColor=muted)
    cell = ParagraphStyle("Cell", parent=body, fontSize=9.5, leading=12, spaceAfter=0)
    white = ParagraphStyle("White", parent=cell, textColor=colors.white, fontName="Helvetica-Bold")
    kpi_num = ParagraphStyle("Kpi", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=22, leading=25, textColor=navy)
    kpi_label = ParagraphStyle("KpiLabel", parent=small, fontSize=8.5, leading=11, textColor=ink)
    kpi_heading = ParagraphStyle("KpiHeading", parent=section, fontSize=12, leading=14, spaceBefore=0, spaceAfter=0)
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(str(output), pagesize=letter, leftMargin=0.58*inch, rightMargin=0.58*inch, topMargin=0.48*inch, bottomMargin=0.52*inch, title="10K Takes - Daily Content Report")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    day = date.fromisoformat(report["reporting_date"])
    generated = datetime.fromisoformat(report["generated_at"]).astimezone(TZ)
    def footer(canvas, document):
        canvas.saveState(); canvas.setStrokeColor(line); canvas.line(doc.leftMargin, 0.37*inch, letter[0]-doc.rightMargin, 0.37*inch)
        canvas.setFont("Helvetica", 8); canvas.setFillColor(muted)
        label = ("FICTIONAL SAMPLE  |  " if report.get("fictional_sample") else "") + "Yesterday: " + day.strftime("%b %-d, %Y") + "  |  Generated: " + generated.strftime("%b %-d, %Y")
        canvas.drawString(doc.leftMargin, 0.22*inch, label); canvas.drawRightString(letter[0]-doc.rightMargin, 0.22*inch, str(document.page)); canvas.restoreState()
    doc.addPageTemplates(PageTemplate(id="report", frames=[frame], onPage=footer))
    logo = Image(str(ROOT / "assets" / "10k-takes-logo-red.png"), width=0.34*inch, height=0.34*inch)
    brand = Table([[logo, paragraph("10K TAKES / CONTENT INTELLIGENCE", kicker)]],
                  colWidths=[0.42*inch, doc.width-0.42*inch])
    brand.setStyle(TableStyle([("VALIGN", (0,0), (-1,-1), "MIDDLE"),
                               ("LEFTPADDING", (0,0), (-1,-1), 0),
                               ("RIGHTPADDING", (0,0), (-1,-1), 0),
                               ("TOPPADDING", (0,0), (-1,-1), 0),
                               ("BOTTOMPADDING", (0,0), (-1,-1), 4)]))
    story = [brand]
    story += [paragraph("10K Takes - Daily Content Report", title), paragraph("REPORTING DATE: " + day.strftime("%A, %B %-d, %Y").upper(), date_style)]
    actual = [p for p in report["platforms"] if p["observed"] is not None]
    tracked = sum(p["observed"] for p in actual) if actual else None
    kpis = Table([[paragraph("YESTERDAY AT A GLANCE", section)]], colWidths=[doc.width])
    kpis = Table([[paragraph("YESTERDAY AT A GLANCE", kpi_heading), "", ""],
                  [paragraph("Unavailable", kpi_num), paragraph(str(report["publication_cohort_count"]), kpi_num), paragraph("Not reported", kpi_num)],
                  [paragraph("All-account impressions", kpi_label), paragraph("Posts published yesterday", kpi_label), paragraph("Performance score", kpi_label)],
                  [paragraph("No complete account-wide daily source", small), paragraph("Across " + str(report["covered_platform_count"]) + " platforms with a saved snapshot", small), paragraph("Incomplete cross-platform coverage", small)]], colWidths=[doc.width/3]*3)
    kpis.setStyle(TableStyle([("SPAN", (0,0), (-1,0))]))
    kpis.setStyle(TableStyle([("BACKGROUND", (0,0), (-1,-1), pale), ("BOX", (0,0), (-1,-1), 0, pale), ("LEFTPADDING", (0,0),(-1,-1),10), ("RIGHTPADDING", (0,0),(-1,-1),8), ("TOPPADDING", (0,0),(-1,-1),7), ("BOTTOMPADDING", (0,0),(-1,-1),5)]))
    story += [kpis, Spacer(1, 8), paragraph("Activity window: " + day.strftime("%b %-d") + " 12:00 a.m. to " + (day+timedelta(days=1)).strftime("%b %-d") + " 12:00 a.m., America/Chicago. Exact account-wide activity is unavailable. Platform totals are matched-post counter changes between daily captures; a brief collection delay may cross midnight. Posts published yesterday show their cumulative post totals at the next-morning capture. The 30-day publication feed does not include every older post.", small), paragraph("Yesterday's executive diagnosis", section), paragraph(report["diagnosis"], body), paragraph("Yesterday's Performance Scorecard", section)]
    score_rows = [[paragraph(x, white) for x in ("Platform", "Yesterday's impressions / views", "Expected baseline*", "Delta*", "Yesterday's signals")]]
    for p in report["platforms"]:
        score_rows.append([paragraph(p["platform"], cell), paragraph(fmt(p["observed"]), cell), paragraph(fmt(p["baseline"]), cell), paragraph(pct(p["delta_percent"]), cell), paragraph(p["signal"], cell)])
    score = Table(score_rows, colWidths=[doc.width*.18, doc.width*.19, doc.width*.16, doc.width*.12, doc.width*.35], repeatRows=1)
    score.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),navy),("TEXTCOLOR",(0,0),(-1,0),colors.white),("GRID",(0,0),(-1,-1),.35,line),("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),6),("RIGHTPADDING",(0,0),(-1,-1),6),("TOPPADDING",(0,0),(-1,-1),7),("BOTTOMPADDING",(0,0),(-1,-1),7)]))
    story += [score, Spacer(1,5), paragraph("*Historical comparators are platform-specific medians of daily changes in tracked-post counters and require at least 7 valid prior daily pairs. They are directional historical references, not forecasts. Views and impressions are not interchangeable. The table is not an all-account total.", small), PageBreak()]
    story += [paragraph("Posts Published Yesterday", title)]
    post_rows = [[paragraph(x, white) for x in ("Post published yesterday", "Yesterday's result", "Yesterday's evidence & interpretation")]]
    selected = report["publication_cohort"]
    if not selected:
        post_rows.append([paragraph("No posts were verified as published during the reporting date.", cell), paragraph("Unavailable", cell), paragraph("Check publication timestamps and the saved midnight snapshots. Missing posts or metrics are not treated as zero.", cell)])
    for post in selected:
        result = (fmt(post["exposure"]) + " " + post["exposure_label"]) if post["exposure"] is not None else "Unavailable: no paired start-of-window counter"
        post_rows.append([paragraph(post["title"] + " (" + post["platform"] + ")", cell), paragraph(result, cell), paragraph("Observed " + post["format"] + " publication. " + post["evidence"] + " No causal explanation is inferred.", cell)])
    ptable = Table(post_rows, colWidths=[doc.width*.31, doc.width*.22, doc.width*.47], repeatRows=1)
    ptable.setStyle(TableStyle([("BACKGROUND",(0,0),(-1,0),navy),("GRID",(0,0),(-1,-1),.35,line),("VALIGN",(0,0),(-1,-1),"TOP"),("LEFTPADDING",(0,0),(-1,-1),7),("RIGHTPADDING",(0,0),(-1,-1),7),("TOPPADDING",(0,0),(-1,-1),8),("BOTTOMPADDING",(0,0),(-1,-1),8)]))
    story += [ptable, Spacer(1,5), paragraph("Selected rows show a representative subset of verified posts, not every post. Views are distinct from impressions and are reported in their platform's units. Publication-date post totals are cumulative at the next-morning capture; daily platform totals are matched-post counter changes. Unavailable counters are not replaced with zero.", small), paragraph("Three Actions For Today - " + generated.strftime("%A, %B %-d"), section)]
    for i, action in enumerate(report["actions"], 1):
        story.append(paragraph(str(i) + ". " + action, body))
    story += [paragraph("Confidence & next data checks", section), paragraph(report["confidence"], body)]
    for note in report["measurement_notes"]:
        story.append(paragraph("• " + note, small))
    doc.build(story)


def snapshot(day, source=ROOT / "top_posts.csv", captured_at=None, overwrite=False):
    SNAPSHOTS.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS / (day.isoformat() + ".json")
    if path.exists() and not overwrite:
        print("Snapshot already saved; keeping original capture: " + str(path))
        return path
    with source.open(newline="", encoding="utf-8-sig") as stream:
        rows = []
        for row in csv.DictReader(stream):
            if row.get("snapshot") != day.isoformat():
                continue
            post = {key: row.get(key) for key in ("platform", "url", "posted_at", "type", "caption", *METRICS)}
            post["posted_at"] = row.get("posted", "")
            post["format"] = row.get("type") or "Post"
            post.pop("type", None)
            for metric in METRICS:
                post[metric] = as_int(post.get(metric))
            rows.append(post)
    value = {"snapshot_date": day.isoformat(), "captured_at": (captured_at or datetime.now(TZ)).isoformat(), "posts": rows}
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Saved {} post rows for {}.".format(len(rows), day.isoformat()))
    return path


def sample_report(day):
    now = datetime.combine(day + timedelta(days=1), time(0, 5), TZ)
    before = {"snapshot_date": day.isoformat(), "captured_at": datetime.combine(day, time(0, 5), TZ).isoformat(), "posts": []}
    after = {"snapshot_date": (day+timedelta(days=1)).isoformat(), "captured_at": now.isoformat(), "posts": []}
    samples = [
        ("Instagram", "Vikings fan reaction (IG)", "Reel", 125000, 62000, 18000),
        ("Facebook", "Bills game reaction (FB)", "Video", 170000, 90000, 32000),
        ("TikTok", "Wild comedy skit", "Video", 19000, 8000, 9000),
        ("YouTube", "Podcast excerpt", "Short", 8000, 3000, 2500),
    ]
    for idx, (platform, caption, kind, prior, change, cohort_views) in enumerate(samples):
        url = "https://example.com/sample/" + str(idx)
        old_url = url + "/older"
        old = {"platform": platform, "url": old_url, "posted_at": datetime.combine(day-timedelta(days=3), time(14, idx), TZ).isoformat(), "format": kind, "caption": caption + " (prior post)", "views": prior, "likes": 100, "comments": 20, "shares": 10, "saves": 4}
        current_old = dict(old, views=prior + change, likes=120, comments=28, shares=14, saves=7)
        before["posts"].append(old); after["posts"].append(current_old)
        posted = datetime.combine(day, time(14, idx), TZ).isoformat()
        cohort = {"platform": platform, "url": url, "posted_at": posted, "format": kind, "caption": caption, "views": cohort_views, "likes": 420, "comments": 34, "shares": 50, "saves": 18}
        after["posts"].append(cohort)
    report = build_report(day, before, after, now)
    report["fictional_sample"] = True
    report["all_account_impressions"] = None
    report["publication_cohort"] = [dict(row, evidence="Fictional sample metrics for layout review; not actual 10K Takes data.") for row in report["publication_cohort"]]
    report["diagnosis"] = "Fictional sample only. This preview demonstrates the report layout and makes no claim about actual account performance."
    report["actions"] = ["Test one comparable fan-reaction post today and record post-level counters at matched post ages.", "Rework the sample comedy opening and compare platform-native performance after a complete capture interval.", "Check collection coverage and note any paid boosting before using these sample comparisons."]
    report["confidence"] = "Fictional sample data only. Production reports use saved Hub snapshots and explicitly flag unavailable or incomplete measurements."
    return report


def deliver(day, status_path, pdf_path, authorized_resend=False):
    status = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {"state": "ready", "reporting_date": day.isoformat()}
    state = status.get("state")
    if state == "sent" and not authorized_resend:
        print("Already sent; duplicate delivery prevented."); return
    if state in ("sending", "delivery_unknown") and not authorized_resend:
        print("Delivery state is ambiguous; check the Resend dashboard before authorizing a resend."); return
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    recipient = (os.environ.get("DAILY_CONTENT_REPORT_TO", "").strip() or os.environ.get("OPPORTUNITIES_EMAIL_TO", "").strip())
    sender = os.environ.get("RESEND_FROM", "").strip()
    if not api_key or not recipient or not sender:
        status.update({"state": "needs_configuration", "updated_at": datetime.now(timezone.utc).isoformat(), "missing": [key for key, value in (("RESEND_API_KEY", api_key), ("DAILY_CONTENT_REPORT_TO or OPPORTUNITIES_EMAIL_TO", recipient), ("RESEND_FROM", sender)) if not value]})
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print("Report generated but not emailed. Configure the listed existing Resend settings."); return
    try:
        attachment = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
    except OSError as error:
        raise RuntimeError("Saved PDF attachment is unavailable: " + str(error))
    attempt = int(status.get("attempt", 0)) + 1
    idem = "10k-daily-content-report-{}-{}".format(day.isoformat(), attempt if authorized_resend else 1)
    status.update({"state": "sending", "attempt": attempt, "updated_at": datetime.now(timezone.utc).isoformat(), "idempotency_key": idem})
    status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    saved_report = {}
    try:
        saved_report = json.loads(report_paths(day)[1].read_text(encoding="utf-8"))
    except OSError:
        pass
    material_gaps = [note.rstrip(".") for note in saved_report.get("measurement_notes", [])
                     if any(term in note.casefold() for term in ("missing", "unavailable", "does not include", "require"))]
    gap_text = "; ".join(material_gaps[:3]) if material_gaps else "No major gap was detected in the available feeds; coverage is not a full-account guarantee"
    email_body = "Attached is the 10K Takes daily content report for yesterday. Reporting date: {}. Material data gaps: {}.".format(day.strftime("%A, %B %-d, %Y"), gap_text)
    payload = json.dumps({"from": sender, "to": [x.strip() for x in recipient.split(",") if x.strip()],
                         "subject": "10K Takes Daily Content Report - " + day.strftime("%B %-d, %Y"),
                         "text": email_body,
                         "attachments": [{"filename": "10K_Takes_Daily_Content_Report_{}.pdf".format(day.isoformat()), "content": attachment}]}).encode()
    request = urllib.request.Request("https://api.resend.com/emails", data=payload, method="POST", headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json", "Idempotency-Key": idem})
    result = None
    for retry in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as error:
            if error.code in (429, 500, 502, 503, 504) and retry < 2:
                time_module.sleep(2 ** retry)
                continue
            body = error.read().decode("utf-8", "replace")[:500]
            status.update({"state": "delivery_failed", "error": "Resend HTTP {}: {}".format(error.code, body), "updated_at": datetime.now(timezone.utc).isoformat()})
            status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
            raise RuntimeError("Resend rejected the report (HTTP {}). See saved status for details.".format(error.code))
        except (urllib.error.URLError, TimeoutError, OSError):
            if retry < 2:
                time_module.sleep(2 ** retry)
                continue
            status.update({"state": "delivery_unknown", "error": "No definitive provider response after retries. Check Resend before an authorized resend.", "updated_at": datetime.now(timezone.utc).isoformat()})
            status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
            raise RuntimeError("Email result is ambiguous; duplicate send is blocked until a manual resend is authorized.")
    if result is None:
        raise RuntimeError("Resend returned no email result.")
    try:
        status.update({"state": "sent", "provider_id": result.get("id"), "updated_at": datetime.now(timezone.utc).isoformat()})
        status_path.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
        print("Daily report email sent for {}.".format(day.isoformat()))
    except OSError as error:
        raise RuntimeError("Email sent, but the saved delivery status could not be written: " + str(error))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("snapshot", "generate", "deliver", "sample"))
    parser.add_argument("--date", help="Reporting date (America/Chicago), YYYY-MM-DD")
    parser.add_argument("--sample-output", default="output/pdf/10K_Takes_Daily_Content_Report_SAMPLE.pdf")
    parser.add_argument("--preview", action="store_true", help="Generate/save only; never email")
    parser.add_argument("--authorized-resend", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    day = date.fromisoformat(args.date) if args.date else (datetime.now(TZ).date() if args.action == "snapshot" else reporting_date())
    try:
        if args.action == "snapshot":
            snapshot(day, overwrite=args.force)
        elif args.action == "sample":
            report = sample_report(day); output = ROOT / args.sample_output; output.parent.mkdir(parents=True, exist_ok=True); render_pdf(report, output); print(output)
        else:
            report, json_path, pdf_path, status_path = load_or_create(day, args.force)
            print("Saved report {} using {} publication-cohort post(s).".format(json_path, report["publication_cohort_total"]))
            print("PDF: {}".format(pdf_path))
            if args.action == "deliver" and not args.preview:
                deliver(day, status_path, pdf_path, args.authorized_resend)
    except (OSError, ValueError, RuntimeError) as error:
        sys.exit(str(error))


if __name__ == "__main__":
    main()
