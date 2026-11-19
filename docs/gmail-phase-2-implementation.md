# Gmail Metadata Sync — Phase 2 Local Implementation

**Status:** Implemented and validated locally only. No Google Cloud project, OAuth client, Gmail API enablement, mailbox authorization, Worker secret, D1 production migration, or deployment was performed.

## Design choices

- OAuth is restricted in code to `partnerships@10ktakesmn.com` and requests only `https://www.googleapis.com/auth/gmail.metadata`.
- The callback verifies the exact mailbox and the granted scope. OAuth state is single-use, expires after 10 minutes, and uses PKCE. Jack's named account is the only account allowed to connect or disconnect the shared mailbox.
- Only the encrypted long-lived refresh token is stored in D1. Access tokens are held in Worker memory. The AES-GCM encryption key and Google OAuth client secret are Worker secrets.
- Gmail API calls use `messages.list` without message search queries and `messages.get?format=metadata` with only From, To, Cc, Subject, Date, Message-ID, In-Reply-To, and References headers. Bodies and attachments are never requested. Gmail's `gmail.metadata` scope does not allow the `q` search parameter, so the initial reconciliation pages through message IDs and reads headers to match against CRM contacts, known company website domains, or an already-linked thread. Unmatched messages are discarded and counted; they are not retained or used to create CRM records.
- Gmail messages are uniquely upserted by Gmail message ID. Gmail metadata is stored in `sales_communications`, separately from Resend `outreach_log` and manual activity entries. Gmail sent status comes only from Gmail labels. Drafts are recognized by the Gmail `DRAFT` label on message metadata; this stores the message ID, not a Gmail Draft resource ID, because the Drafts resource endpoints require a broader scope.
- Initial sync and history processing are durable and bounded: up to 100 list IDs per scheduled page and 30 metadata message reads per run. A 15-minute Cron trigger drains the queue and polls Gmail history. Expired history IDs restart initial reconciliation. Manual sync is capped at four calls per actor per minute.
- A matched outgoing Gmail message creates one follow-up task due four business days later. A reply in that Gmail thread cancels the open task. Resend messages do not create or satisfy Gmail tasks.
- The dashboard has Gmail connection/status controls and adds Gmail + Resend communications and contact dates to the existing CRM record Activity Timeline. No message sending or Gmail draft creation is included.

## Endpoints

- `GET /v1/sales/gmail/status` — configuration, connection, last sync, initial scan state, and counts.
- `POST /v1/sales/gmail/connect` — Jack-only OAuth URL creation.
- `GET /v1/sales/gmail/callback` — public OAuth callback guarded by one-time state and PKCE.
- `POST /v1/sales/gmail/sync` — authenticated bounded manual sync.
- `POST /v1/sales/gmail/disconnect` — Jack-only token revocation; existing CRM communication rows remain.
- `GET /v1/sales/gmail/communications?record_id=…` — timeline plus latest sent, reply, and follow-up dates for an existing record.

The regular `/v1/sales/*` authentication/origin checks remain in place. The new Gmail routes use the existing named-user tokens, D1 audit log, a per-actor rate limit, and restrictive CORS. There is no Gmail send or modify operation.

## Additive migration

`workers/sales-command-center/migrations/0006_gmail_internal_metadata_sync.sql` adds encrypted-token and OAuth-state tables, queue/cursor columns, metadata label/deletion fields, and removes any old Gmail snippet/body values. It does not update or delete CRM records, `sales_records`, Resend logs, or manual activities. The migration is not designed to be run twice; use Wrangler migration history to apply it once.

## Configuration needed before a future rollout

Nothing is set by this implementation. If/when you approve a rollout, configure these on the Worker:

- `GOOGLE_OAUTH_CLIENT_ID` — OAuth client ID variable.
- `GOOGLE_OAUTH_CLIENT_SECRET` — secret.
- `GOOGLE_OAUTH_REDIRECT_URI` — exact HTTPS Worker URL ending in `/v1/sales/gmail/callback`.
- `GMAIL_TOKEN_ENCRYPTION_KEY` — secret decoding to exactly 32 bytes, encoded as base64url. Keep it backed up and stable; rotating it without re-encrypting the stored refresh token will require reconnecting Gmail.

Google OAuth app eligibility and any Workspace administrator approval remain external setup questions. Keep the app Internal and the Cloud project owned by the same Workspace organization if eligible. `gmail.metadata` is a restricted scope, and its approval/security-assessment treatment must follow Google's current written guidance for your specific Internal app. The local code does not claim that a Google exception or security assessment has been granted.

## First ten outreach brands

Sync correlates to CRM contacts by normalized email, then to known CRM company websites by email domain, then to a previously linked Gmail thread. It deliberately does not guess people or auto-create contacts. Existing history that has no CRM contact/website evidence will be reported as unmatched and needs CRM contact/domain data before it can be attributed. Review the `matched`, `unmatched`, and `pending` sync counts before treating the ten-brand reconciliation as complete.

## Local validation and rollout boundary

From `workers/sales-command-center`:

```sh
npm test
npx tsc src/index.ts --target ES2022 --module commonjs --lib ES2022,DOM --skipLibCheck --noEmit
```

Tests use a temporary SQLite database and mocked Google HTTP responses. They do not enable Gmail API, create credentials, connect a real mailbox, or contact Cloudflare. Before any production rollout: apply 0006 to a preview D1, validate contact/company matches and unmatched counts, verify scheduled-trigger configuration, and use the existing previous-Worker rollback while leaving additive tables intact. No deployment or remote migration is authorized or performed here.
