"""Fail the run when a daily main-account snapshot is missing; retain good data."""
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

def check(root, today):
    latest = {}
    for filename in ('followers.csv', 'metrics.csv'):
        with (Path(root) / filename).open(newline='') as source:
            for row in csv.DictReader(source):
                if row['account'] != '10K Takes':
                    continue
                key = (row['platform'], row.get('metric', 'followers'))
                latest[key] = max(latest.get(key, ''), row['date'])
    missing = []
    for platform in ('Facebook', 'Instagram', 'YouTube', 'TikTok', 'Threads'):
        for metric in ('followers', 'views_7d', 'engagements_7d'):
            last = latest.get((platform, metric), '')
            if last != today:
                missing.append('%s %s: latest %s; expected %s' % (platform, metric, last or 'never', today))
    return missing

def main():
    missing = check('.', datetime.now(timezone.utc).date().isoformat())
    outcomes = json.loads(os.environ.get('COLLECTION_STEPS', '{}'))
    failures = [name for name, step in outcomes.items() if step.get('outcome') == 'failure']
    lines = ['## Collection health', *['- ' + item for item in missing], *['- Failed step: ' + name for name in failures]]
    if not missing and not failures:
        lines.append('All daily main-account snapshots are current and collector steps succeeded.')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write('\n'.join(lines) + '\n')
    for item in missing:
        print('::error::' + item)
    if missing or failures:
        sys.exit('Collection incomplete. Successful snapshots were saved; inspect failed collector steps.')

if __name__ == '__main__':
    main()
