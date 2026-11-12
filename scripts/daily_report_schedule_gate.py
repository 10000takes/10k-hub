#!/usr/bin/env python3
"""GitHub Actions schedule gates for the Chicago-local daily report."""
import os
from datetime import datetime
from zoneinfo import ZoneInfo

mode = os.environ.get("REPORT_MODE", "scheduled")
event = os.environ.get("GITHUB_EVENT_NAME", "schedule")
if event == "workflow_dispatch":
    should_run = True
else:
    requested = os.environ.get("DAILY_CONTENT_REPORT_TIME", "08:00").strip()
    try:
        hour, minute = (int(x) for x in requested.split(":"))
        if not (0 <= hour <= 23 and minute == 0):
            raise ValueError
    except ValueError:
        raise SystemExit("DAILY_CONTENT_REPORT_TIME must be an hourly time such as 08:00.")
    current = datetime.now(ZoneInfo("America/Chicago"))
    should_run = current.hour == hour

print("run={}".format("true" if should_run else "false"))
