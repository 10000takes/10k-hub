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
npx wrangler secret put SALES_API_TOKEN
npx wrangler deploy
```

Use a random token of at least 32 characters. Keep it private and enter it only in the dashboard Partnerships tab. Do not reuse the Content Intelligence `AGENT_TOKEN` or put this token in GitHub Actions variables, frontend code, or this repository. Set `PUBLIC_READ_ORIGIN` to the exact dashboard origin (scheme + host, no path). After deploy, use `https://10k-takes-sales-command-center.<your-workers-subdomain>.workers.dev` as the Partnerships Worker URL.

The dashboard keeps the token in session storage until the browser session ends. This is a single shared credential rather than user accounts or roles. Anyone with the token can access CRM records. Do not share access with a team until identity-based access is configured. CORS is not authentication.

## API

- `GET /health` — liveness.
- `GET /v1/sales/records` — list private records.
- `POST /v1/sales/records` — create a client, lead, or prospect.
- `PATCH /v1/sales/records/:id` — update a record.
- `DELETE /v1/sales/records/:id` — delete a record and its activity history.
- `GET /v1/sales/activities?record_id=...` — read a record's activity timeline.
- `POST /v1/sales/activities` — add an activity note.

Every `/v1/sales/*` request requires `Authorization: Bearer <SALES_API_TOKEN>` and the configured dashboard origin. The API does not send email or outreach and does not call external discovery providers.

## Current scope

This first release supports client, lead, and manually researched prospect records; contract/revenue fields; activity timelines; lead stage changes; follow-up and contract-expiry reminders; CSV lead import; pipeline/revenue summaries; and manual prospect promotion into leads. Estimates and fit scores are user-entered. AI lead scoring/recommendations, automatic external brand discovery, historical revenue charts, complete deliverable tracking, proposals, renewal emails, and multi-user authorization remain future work.
