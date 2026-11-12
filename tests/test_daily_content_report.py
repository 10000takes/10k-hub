import importlib.util
import json
import csv
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "daily_report", ROOT / "scripts" / "generate_daily_content_report.py"
)
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


def row(platform="X/Twitter", url="https://x.test/1", posted_at="2026-11-11T18:00:00-06:00",
        views=200, likes=10, comments=2, shares=3, saves=1, caption="A sample"):
    return {"platform": platform, "url": url, "posted_at": posted_at, "views": views,
            "likes": likes, "comments": comments, "shares": shares, "saves": saves,
            "caption": caption, "format": "Video"}


class DailyReportTests(unittest.TestCase):
    def test_reporting_date_is_previous_chicago_calendar_day(self):
        self.assertEqual(report.reporting_date(datetime(2026, 11, 12, 13, tzinfo=timezone.utc)), date(2026, 11, 11))
        self.assertEqual(report.reporting_date(datetime(2026, 3, 9, 5, 30, tzinfo=timezone.utc)), date(2026, 3, 8))

    def test_reporting_window_respects_dst_length(self):
        spring_start, spring_end = report.reporting_window(date(2026, 3, 8))
        fall_start, fall_end = report.reporting_window(date(2026, 11, 1))
        self.assertEqual((spring_end.astimezone(timezone.utc) - spring_start.astimezone(timezone.utc)).total_seconds(), 23 * 3600)
        self.assertEqual((fall_end.astimezone(timezone.utc) - fall_start.astimezone(timezone.utc)).total_seconds(), 25 * 3600)

    def test_publication_date_uses_chicago_timezone(self):
        self.assertEqual(report.local_post_date("2026-11-12T05:30:00Z"), date(2026, 11, 11))
        self.assertEqual(report.local_post_date("not-a-date"), None)

    def test_missing_and_decreasing_metrics_are_unavailable_not_zero(self):
        self.assertIsNone(report.counter_delta(None, 10))
        self.assertIsNone(report.counter_delta(9, 10))
        self.assertEqual(report.counter_delta(10, 10), 0)
        prior = {"posts": [row(views=10)]}
        current = {"posts": [row(views=None)]}
        self.assertEqual(report.platform_deltas(prior, current), ({}, {}))

    def test_snapshot_rejects_wrong_date_and_import_saves_only_requested_capture(self):
        day = date(2026, 11, 11)
        with tempfile.TemporaryDirectory() as tmp:
            snapshot_root = Path(tmp)
            path = snapshot_root / (day.isoformat() + ".json")
            path.write_text(json.dumps({"snapshot_date": "2026-11-10", "posts": []}))
            with mock.patch.object(report, "SNAPSHOTS", snapshot_root):
                with self.assertRaises(ValueError):
                    report.read_snapshot(day)
                path.unlink()
                source = snapshot_root / "top_posts.csv"
                with source.open("w", newline="", encoding="utf-8") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(["snapshot", "platform", "url", "posted", "type", "caption", "views", "likes", "comments", "shares", "saves"])
                    writer.writerow([day.isoformat(), "X/Twitter", "https://x.test/1", "2026-11-11T18:00:00Z", "Post", "Text", "20", "1", "2", "3", "0"])
                    writer.writerow(["2026-11-10", "X/Twitter", "https://x.test/2", "2026-11-10T18:00:00Z", "Post", "Old", "99", "1", "2", "3", "0"])
                report.snapshot(day, source=source)
                saved = report.read_snapshot(day)
                self.assertEqual(len(saved["posts"]), 1)
                self.assertEqual(saved["posts"][0]["views"], 20)

    @mock.patch.object(report, "read_snapshot", return_value=None)
    def test_publication_cohort_uses_since_publication_totals_not_lifetime_comparison(self, _read):
        day = date(2026, 11, 11)
        before = {"captured_at": "2026-11-11T00:05:00-06:00", "posts": []}
        after = {"captured_at": "2026-11-12T00:05:00-06:00", "posts": [row(views=523, likes=40, comments=7, shares=3, saves=2)]}
        result = report.build_report(day, before, after)
        post = result["publication_cohort"][0]
        self.assertEqual(post["exposure"], 523)
        self.assertEqual(post["engagements"], 52)
        self.assertIn("Cumulative post counters", post["evidence"])
        self.assertIsNone(result["all_account_impressions"])
        self.assertIsNone(result["score"])

    @mock.patch.object(report, "read_snapshot")
    def test_platform_deltas_require_matching_rows_and_baselines_need_seven_days(self, read):
        today = date(2026, 11, 11)
        snapshots = {}
        for offset in range(7, -1, -1):
            d = today - timedelta(days=offset)
            snapshots[d] = {"posts": [row(views=100 + (7 - offset) * 10)]}
        read.side_effect = lambda d: snapshots.get(d)
        baseline = report.historical_baselines(today, None)["X/Twitter"]
        self.assertEqual(baseline["days"], 7)
        self.assertEqual(baseline["median"], 10)
        before = {"posts": [row(views=100)]}
        after = {"posts": [row(url="https://x.test/2", views=500)]}
        self.assertEqual(report.platform_deltas(before, after), ({}, {}))

    def test_delivery_status_blocks_duplicates_and_missing_config(self):
        day = date(2026, 11, 11)
        with tempfile.TemporaryDirectory() as tmp:
            status_path = Path(tmp) / "status.json"
            pdf_path = Path(tmp) / "report.pdf"
            pdf_path.write_bytes(b"fake pdf")
            status_path.write_text(json.dumps({"state": "sent"}))
            with mock.patch.object(report.urllib.request, "urlopen") as send:
                report.deliver(day, status_path, pdf_path)
                send.assert_not_called()
            status_path.write_text(json.dumps({"state": "ready"}))
            with mock.patch.dict("os.environ", {"RESEND_API_KEY": "", "DAILY_CONTENT_REPORT_TO": "", "OPPORTUNITIES_EMAIL_TO": "", "RESEND_FROM": ""}, clear=False):
                report.deliver(day, status_path, pdf_path)
            self.assertEqual(json.loads(status_path.read_text())["state"], "needs_configuration")

    def test_successful_delivery_payload_has_expected_recipient_subject_and_attachment(self):
        day = date(2026, 11, 11)
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return b'{"id":"email-123"}'
        with tempfile.TemporaryDirectory() as tmp:
            status_path, pdf_path = Path(tmp) / "status.json", Path(tmp) / "report.pdf"
            status_path.write_text(json.dumps({"state": "ready"}))
            pdf_path.write_bytes(b"sample attachment")
            def fake_send(request, timeout):
                self.assertEqual(timeout, 30)
                self.assertTrue(request.get_header("Idempotency-key"))
                payload = json.loads(request.data)
                self.assertEqual(payload["to"], ["owner@example.com"])
                self.assertEqual(payload["subject"], "10K Takes Daily Content Report - November 11, 2026")
                self.assertIn("Material data gaps:", payload["text"])
                self.assertEqual(payload["attachments"][0]["filename"], "10K_Takes_Daily_Content_Report_2026-11-11.pdf")
                return Response()
            with mock.patch.dict("os.environ", {"RESEND_API_KEY": "test-key", "DAILY_CONTENT_REPORT_TO": "owner@example.com", "RESEND_FROM": "reports@example.com"}, clear=False), \
                 mock.patch.object(report.urllib.request, "urlopen", side_effect=fake_send):
                report.deliver(day, status_path, pdf_path)
            self.assertEqual(json.loads(status_path.read_text())["state"], "sent")

    def test_delivery_retries_with_same_key_and_blocks_ambiguous_resend(self):
        day = date(2026, 11, 11)
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return b'{"id":"email-456"}'
        with tempfile.TemporaryDirectory() as tmp:
            status_path, pdf_path = Path(tmp) / "status.json", Path(tmp) / "report.pdf"
            status_path.write_text(json.dumps({"state": "ready"}))
            pdf_path.write_bytes(b"sample attachment")
            headers = []
            def maybe_timeout(request, timeout):
                headers.append(request.get_header("Idempotency-key"))
                if len(headers) == 1:
                    raise report.urllib.error.URLError("temporary timeout")
                return Response()
            with mock.patch.dict("os.environ", {"RESEND_API_KEY": "test-key", "DAILY_CONTENT_REPORT_TO": "owner@example.com", "RESEND_FROM": "reports@example.com"}, clear=False), \
                 mock.patch.object(report.urllib.request, "urlopen", side_effect=maybe_timeout), \
                 mock.patch.object(report.time_module, "sleep"):
                report.deliver(day, status_path, pdf_path)
            self.assertEqual(len(headers), 2)
            self.assertEqual(headers[0], headers[1])
            self.assertEqual(json.loads(status_path.read_text())["state"], "sent")

            status_path.write_text(json.dumps({"state": "delivery_unknown"}))
            with mock.patch.object(report.urllib.request, "urlopen") as send:
                report.deliver(day, status_path, pdf_path)
                send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
