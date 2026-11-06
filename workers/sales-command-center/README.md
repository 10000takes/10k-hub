# 10K Takes Sales Command Center Worker

Standalone Cloudflare Worker and D1 database for the Sales Command Center. It is separate from the Content Intelligence Worker, token, and database. Private sales records must never be added to GitHub Pages JSON, CSV, or other public files.

## Initial setup

From this directory:

```sh
npm install
npx wrangler d1 create 10k-takes-sales-command-center
```

Copy the returned database UUID into `wrangler.jsonc`, replacing `REPLACE_WITH_SALES_D1_DATABASE_ID`. Then apply the schema, add a separate secret, and deploy:

```sh
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=schema.sql
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=migrations/0002_partnerships_features.sql
npx wrangler secret put SALES_API_TOKEN
npx wrangler deploy
```

Use a random token of at least 32 characters. Keep it private and enter it only in the dashboard Partnerships tab. Do not reuse the Content Intelligence `AGENT_TOKEN` or put this token in GitHub Actions variables, frontend code, or this repository. Set `PUBLIC_READ_ORIGIN` to the exact dashboard origin (scheme + host, no path). After deploy, use `https://10k-takes-sales-command-center.<your-workers-subdomain>.workers.dev` as the Partnerships Worker URL.

The dashboard keeps the token in session storage until the browser session ends. This is a single shared credential rather than user accounts or roles. Anyone with the token can access CRM records. Do not share access with a team until identity-based access is configured. CORS is not authentication.

## Additive feature schema

Before deploying the updated Worker, apply the additive migration to the existing remote D1 database from this directory:

```sh
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=migrations/0002_partnerships_features.sql
```

The migration adds monthly received-revenue entries, recurring deliverable definitions and month-by-month completion records, and an outreach audit log. It does not replace the existing schema or delete CRM records. Back up the D1 database before applying it.

## API

- `GET /health` — liveness.
- `GET /v1/sales/records` — list private records.
- `POST /v1/sales/records` — create a client, lead, or prospect.
- `PATCH /v1/sales/records/:id` — update a record.
- `DELETE /v1/sales/records/:id` — delete a record and its activity history.
- `GET /v1/sales/activities?record_id=...` — read a record's activity timeline.
- `POST /v1/sales/activities` — add an activity note.
- `GET, POST /v1/sales/revenue` — list or log a monthly revenue entry.
- `GET /v1/sales/deliverables?month=YYYY-MM` — list active commitments and their completion for a month.
- `POST /v1/sales/deliverables/definitions` — add a client's recurring monthly deliverable commitment.
- `POST /v1/sales/deliverables/completions` — upsert the completed count and publication URL for a commitment/month.
- `GET /v1/sales/discovery?q=...` — search public Google News RSS results. Results are unverified research leads.
- `POST /v1/sales/assist` — request an optional Workers AI lead score, sales advice, or proposal draft using supplied CRM facts.
- `POST /v1/sales/outreach` — send one email only when `confirm_send: true`, Resend secrets are configured, and the user has reviewed/approved the message in the dashboard.

Every `/v1/sales/*` request requires `Authorization: Bearer <SALES_API_TOKEN>` and the configured dashboard origin. News search uses a public RSS feed and does not scrape social accounts or private contact databases.

## Current scope

The Partnerships UI now supports client, lead, and research-prospect records; contact/contract data; stage history; follow-up reminders; CSV import; pipeline summaries; manually entered monthly revenue history and charts; and monthly deliverable commitments/completion tracking. News discovery is on-demand and source-linked. Optional AI assistance requires enabling the Cloudflare Workers AI binding `AI`; without it the endpoint returns a clear unavailable response. One-to-one email requires `RESEND_API_KEY` and `RESEND_FROM` Worker secrets with a verified sender. Each message is sent only after an explicit user confirmation, and send events are logged. Do not configure either external service without owner review.

Amounts are user-entered; the monthly chart sums entries marked `received`. Prospect search results are leads for human research and do not validate deal fit or contacts. AI scores, advice, and proposal/pricing are drafts, never automatic approvals. The tracker cannot verify publication unless a URL is recorded. Shared-token authorization remains the current access model.

## Optional service setup

To enable AI, configure the Cloudflare Workers AI binding named `AI` in the Worker settings (or in `wrangler.jsonc`) and then deploy. To enable email, first verify the sender domain with Resend, then configure `RESEND_API_KEY` and `RESEND_FROM` as Worker secrets. Wrangler secret writes deploy immediately. The code does not configure or deploy these bindings/secrets. Review current provider pricing before enabling; Cloudflare Workers AI's published free allowance and Resend's free email quota may change.
