# Daily Content Report

The Daily Content Report produces a saved, two-page PDF for the previous calendar day in America/Chicago and emails it at 8:00 a.m. Central by default. The send-time is configurable in whole-hour increments with the repository variable `DAILY_CONTENT_REPORT_TIME` (for example, `08:00`). GitHub Actions schedules are approximate; GitHub can start a scheduled run late.

## Activation

This feature is not active until the workflow files are committed and pushed to the repository's default branch. It reuses the existing Resend integration and its Actions secrets:

- `RESEND_API_KEY`
- `RESEND_FROM`
- Recipient: existing secret `OPPORTUNITIES_EMAIL_TO`, or a dedicated `DAILY_CONTENT_REPORT_TO` secret (comma-separated recipients are accepted).

The recipient defaults to the already configured opportunity-report recipient if the dedicated setting is absent. No address or sender is hard-coded. If a required setting is missing, the job saves the PDF and records `needs_configuration` without sending.

In GitHub, open **Actions → Daily Content Report → Run workflow**. Choose **Preview** to generate without emailing. Choose **Send** to send the report for the optional reporting date (blank means yesterday). Choose **Resend** only after confirming the message was not received or a duplicate is intentionally needed. Scheduled sends occur once daily. The report workflow saves the PDF, JSON, and delivery status in `.github/content-report-data/reports/`; the run also retains an artifact for 90 days. This path is not part of the GitHub Pages site.

GitHub Actions must be allowed to write to the repository because each immutable snapshot and report status is saved to Git. Secrets must remain Actions secrets; do not add their values to source files, normal variables, or reports.

## Main-account X collection and cost

The existing main-account post collector refreshes X posts daily. The report adds a separate shortly-after-midnight capture so it can compare public counters with the prior capture. This is an additional X API read and may add usage-based cost. The report does not read X data for subsidiary accounts in that extra capture.

X currently lists usage-based costs of $0.005 per post read and $0.01 per user read. At the configured 30-post cap, the extra nightly X post capture plus the main-account daily follower lookup is approximately **$5.10/month** at full usage (30 days × [30 posts × $0.005 + two user reads × $0.01]). Actual cost depends on how many posts are returned and the rates shown in the X Developer Console. The estimate excludes the already-existing daily X post collector and Friday all-account collection. [Current X API pricing](https://developer.x.com/)

Main-account X follower counts now also have a daily 6:00 a.m. Central workflow. The existing Friday workflow continues to refresh all six accounts and the weekly X post metrics. The new daily follower workflow calls the X users endpoint once for the main account only; no other subsidiary follower collectors were changed. The two scheduled UTC entries and local-time gate account for daylight saving time.

## Measurement definitions and limits

- Reporting dates and post publication dates use `America/Chicago`; the report date is yesterday's local calendar date.
- The midnight capture uses paired daily captures of the rolling, recent post feeds. Platform-level activity is the sum of counter changes only for posts present in both captures. Missing posts and metrics are unavailable, never silently zero.
- This is **tracked-post activity**, not a complete all-account total: platform feeds have limits and generally cover about the last 30 days. The report labels all-account impressions and an overall performance score unavailable rather than presenting partial tracked-post sums as a full account total.
- For the publication cohort, the post's cumulative counters at the next-morning capture are reported. Because the post was published on the reporting date, those counts accrued after publication; the capture may include a short delay beyond midnight. The report labels this as a post total at capture, not an exact midnight-cutoff total.
- Views and X impressions are distinct. Each is compared only within its own platform.
- Baselines use the median of valid daily changes in tracked-post counters over the prior 28 possible calendar days. A platform baseline is shown only after at least seven valid daily comparisons. Missing or stale captures do not count as zero.
- A first report can have missing activity or baselines until two captures exist and enough historical daily comparisons accumulate. A missing snapshot is recorded, not backfilled from lifetime counters.
- The midnight workflow runs at the local midnight UTC equivalent and has a one-hour fallback for the spring-forward transition. The report records actual capture timestamps; any late capture is disclosed.
- Three deterministic recommendations use only the captured post evidence and baseline. They are editorial actions, not causal findings about a platform's algorithm.

## Reliability and privacy

Snapshot and report commits are protected by GitHub Actions concurrency groups. The Resend request uses the same idempotency key for same-report retries; its email API supports idempotency keys for duplicate requests ([Resend documentation](https://resend.com/changelog/idempotency-keys)). A definite rejection is recorded as `delivery_failed`. If no definitive response arrives after retries, delivery is recorded as `delivery_unknown` and automatic duplicate sending is blocked. Check Resend before using the explicit **Resend** action.

PDFs and report JSON are kept under `.github/content-report-data/`, not the public dashboard root. Repository history is still retained; limit repository access to authorized staff. The public captions and posts are treated as untrusted data and are escaped for PDF display. No generative model is used in this feature.

## Local preview

With Python and ReportLab installed, generate the explicitly fictional sample without using real account metrics:

```sh
python scripts/generate_daily_content_report.py sample
```

The sample PDF is written to `output/pdf/10K_Takes_Daily_Content_Report_SAMPLE.pdf`. The Actions **Preview** mode generates a real-data draft for the requested date but never sends it to the production recipient.
