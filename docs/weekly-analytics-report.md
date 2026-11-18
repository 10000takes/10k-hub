# Weekly Analytics Report

The Weekly Analytics Report creates a clean PDF and emails it to `10000takes@gmail.com` on Friday mornings at 8:00 a.m. America/Chicago. It reuses the existing Resend Actions secrets `RESEND_API_KEY` and `RESEND_FROM`; it does not require new secrets. The PDF, JSON data, and email status are saved under `.github/content-report-data/weekly-reports/` and attached to the Actions run for 90 days.

Use **Actions → Weekly Analytics Report → Run workflow → Preview** to generate a PDF without emailing. Choose **Send** for an explicit email or **Resend** only after checking whether an earlier message arrived. An optional report date is the end-capture date (`YYYY-MM-DD`); the report covers the seven days ending at that capture.

## What it measures

- Main account and subsidiary follower changes compare the saved follower counts on the start and end dates. The report shows per-platform values and account-platform coverage. It identifies incomplete totals instead of presenting partial sums as complete.
- Views and X impressions are calculated from consecutive daily snapshots over the current seven days and the previous seven days. Platform values use native counters; the combined number is a convenience sum and is not a standardized cross-platform measure.
- Top posts are ranked by measured views or impressions accrued during the current seven-day window, using paired counter snapshots. Posts without enough counter evidence are excluded.
- The midnight snapshots sample recent posts and do not represent a guaranteed complete account-wide platform-insights total. Missing snapshots, stale counters, and incomplete platform coverage remain visible as unavailable in the report.

If the report run has no snapshot for its current date and `top_posts.csv` also has no current rows, the workflow refreshes recent main-account posts using the existing collector credentials, then saves a same-day snapshot. This prevents a stale checkout from stopping PDF generation. A same-day refresh can occur later than midnight, and the capture time is retained in the saved snapshot. It cannot reconstruct missed historical captures, so the first report can still show post-performance sections as unavailable.

The first weekly report may have an unavailable previous-week comparison until 14 days of midnight snapshots exist. Subsidiary X follower change requires X follower snapshots at both weekly endpoints; the existing Friday X collector supplies these readings.

The workflow is scheduled for Friday at 8:00 a.m. Central and uses the existing Resend configuration. GitHub scheduled workflow starts can be delayed; the schedule gate skips late starts outside the delivery hour rather than sending the report at an unexpected time.
