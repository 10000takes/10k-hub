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
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=migrations/0003_sales_foundation.sql
npx wrangler secret put SALES_JACK_TOKEN
npx wrangler secret put SALES_CODY_TOKEN
npx wrangler deploy
```

Generate two different random tokens of at least 32 characters, one for Jack and one for Cody. Wrangler will prompt for each value; keep them private and enter the matching token only in the dashboard Partnerships tab. Do not reuse the Content Intelligence `AGENT_TOKEN` or put tokens in GitHub Actions variables, frontend code, or this repository. Set `PUBLIC_READ_ORIGIN` to the exact dashboard origin (scheme + host, no path). After deploy, use `https://10k-takes-sales-command-center.<your-workers-subdomain>.workers.dev` as the Partnerships Worker URL.

The dashboard keeps the selected user's token in session storage until the browser session ends and displays the authenticated user's name and role. The Worker maps each secret to a D1 user; tokens are not stored in D1. During rollout, `SALES_API_TOKEN` is accepted only while neither named token is configured, and that legacy identity cannot send email. Once either named token is set, the old shared token is rejected. Configure both named secrets before deploying so Jack and Cody both retain access. CORS is not authentication.

## Additive feature schema

Before deploying the updated Worker, apply the additive migration to the existing remote D1 database from this directory:

```sh
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=migrations/0002_partnerships_features.sql
npx wrangler d1 execute 10k-takes-sales-command-center --remote --file=migrations/0003_sales_foundation.sql
```

Migration 0002 adds monthly received-revenue entries, recurring deliverable definitions, month-by-month completion records, and an outreach log. Migration 0003 adds named users, audit history, opt-out suppression, evidence provenance, agency relationships, modular discovery source configuration, configurable weekly targets and cost ceiling, and scheduled-agent run tracking. Both are additive and preserve existing CRM records. Back up the D1 database before applying migrations.

## API

- `GET /health` — liveness.
- `GET /v1/sales/records` — list private records.
- `GET /v1/sales/session` — return the authenticated named user and role.
- `GET /v1/sales/audit?limit=...` — list recent action audit entries.
- `GET, PATCH /v1/sales/agent-settings` — read or configure weekly target ranges and the monthly cost ceiling (capped at $50).
- `GET, POST /v1/sales/suppressions` — list or add email/domain opt-outs.
- `GET, POST /v1/sales/research-sources` — read or record HTTPS evidence with confidence, capture time, and author.
- `GET, POST /v1/sales/relationships` — list or link an agency to a represented brand.
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

Every `/v1/sales/*` request requires `Authorization: Bearer <individual user token>` and the configured dashboard origin. Resend requests require a per-message user confirmation and a named Jack/Cody identity; shared legacy access is denied. A lead must contain the exact recipient email and an HTTPS Contact Source URL. Existing-client companies and contact addresses, suppressed addresses/domains, and recipients or leads contacted in the previous 24 hours are blocked. Discovery remains on-demand in Phase 1; the source registry and run/settings tables prepare for scheduled discovery but do not start a background scan yet. Source research must use permitted public sources and keep URL, timestamp, confidence and fact evidence.

## Current scope

The Partnerships UI now supports client, lead, and research-prospect records; contact/contract data; stage history; follow-up reminders; CSV import; pipeline summaries; manually entered monthly revenue history and charts; and monthly deliverable commitments/completion tracking. News discovery is on-demand and source-linked. Optional AI assistance requires enabling the Cloudflare Workers AI binding `AI`; without it the endpoint returns a clear unavailable response. One-to-one email requires `RESEND_API_KEY` and `RESEND_FROM` Worker secrets with a verified sender. Each message is sent only after an explicit user confirmation, and send events are logged. Do not configure either external service without owner review.

Amounts are user-entered; the monthly chart sums entries marked `received`. Prospect search results are leads for human research and do not validate deal fit or contacts. AI scores, advice, and proposal/pricing are drafts, never automatic approvals. The tracker cannot verify publication unless a URL is recorded. Email sending remains human-triggered and is never automatic.

## Optional service setup

To enable AI, configure the Cloudflare Workers AI binding named `AI` in the Worker settings (or in `wrangler.jsonc`) and then deploy. To enable email, first verify the sender domain with Resend, then configure `RESEND_API_KEY` and `RESEND_FROM` as Worker secrets. Wrangler secret writes deploy immediately. The code does not configure or deploy these bindings/secrets. Review current provider pricing before enabling; Cloudflare Workers AI's published free allowance and Resend's free email quota may change.
