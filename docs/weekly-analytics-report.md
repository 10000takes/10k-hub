# Weekly Analytics Report

The Weekly Analytics Report creates a clean PDF and emails it to `10000takes@gmail.com` on Friday mornings at 8:00 a.m. America/Chicago. It reuses the existing Resend Actions secrets `RESEND_API_KEY` and `RESEND_FROM`; it does not require new secrets. The PDF, JSON data, and email status are saved under `.github/content-report-data/weekly-reports/` and attached to the Actions run for 90 days.

Use **Actions → Weekly Analytics Report → Run workflow → Preview** to generate a PDF without emailing. Choose **Send** for an explicit email or **Resend** only after checking whether an earlier message arrived. An optional report date is the end-capture date (`YYYY-MM-DD`); the report covers the seven days ending at that capture.

## What it measures

- Main account and subsidiary follower changes compare the latest saved count readings seven days apart, when the newest reading is no more than one day behind the report date. The report shows per-platform values and pair coverage. Incomplete totals are labeled partial.
- Main-account views and X impressions use the saved `views_7d` rows in `metrics.csv`, compared with that platform's reading seven days earlier. The total uses only platforms with both readings and shows its coverage; it is a convenience sum of platform-native metrics, not a standardized cross-platform measure.
- Top posts are posts published in the reporting week, ranked by their available cumulative view or impression counts at the latest saved post snapshot. The posts have different ages, so these are not equal-age comparisons.
- Post snapshots sample recent posts and do not represent guaranteed complete account-wide platform insights. Missing or stale source metrics are labeled unavailable.

If the report run has no snapshot for its current date and `top_posts.csv` also has no current rows, the workflow refreshes recent main-account posts using the existing collector credentials, then saves a same-day snapshot. This prevents a stale checkout from stopping PDF generation. A same-day refresh can occur later than midnight, and the capture time is retained in the saved snapshot. It cannot reconstruct missed historical captures, so the first report can still show post-performance sections as unavailable.

The report uses rolling account-level metrics for the week-over-week comparison, so it does not require 14 days of midnight post snapshots. A platform remains unavailable when its metrics file lacks a current reading or a reading from seven days earlier. Subsidiary X follower change requires X follower snapshots at both weekly endpoints; the existing Friday X collector supplies these readings.

The workflow is scheduled for Friday at 8:00 a.m. Central and uses the existing Resend configuration. GitHub scheduled workflow starts can be delayed; the schedule gate skips late starts outside the delivery hour rather than sending the report at an unexpected time.
