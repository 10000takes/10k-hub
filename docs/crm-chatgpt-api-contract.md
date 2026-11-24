# 10K Hub CRM Integration API Contract

This contract is implemented under `/v1/crm/*` in the Sales Command Center Worker. It is separate from the existing `/v1/sales/*` dashboard API. The existing API and `sales_records` model remain supported; `sales_records` with `entity_type='lead'` continue to represent opportunities.

## Authentication and protections

- Send `Authorization: Bearer <high-entropy integration key>`.
- Keys are stored as SHA-256 hashes in D1, with an explicit scope list, creator, expiry, revocation time, and per-minute limit. The raw key is never stored or returned by the Worker. Phase 1 does not create any live integration keys.
- Jack and Cody named-user tokens are accepted for direct first-party use. Integration keys must be scoped only to the operations ChatGPT needs.
- Every CRM write requires a unique `Idempotency-Key` (12–128 characters). Replaying the same key and request returns the original response; using the key for another request returns `409`.
- CRM API requests are limited per principal and are audited. The API intentionally sends no browser CORS permission; credentials belong in the integration's server-side/API-key configuration, never in GitHub Pages or frontend code.
- All request bodies are JSON and capped at 30 KB. Dates use `YYYY-MM-DD`; email values are normalized to lowercase.

## Scope names

`companies:read`, `companies:write`, `contacts:read`, `contacts:write`, `prospects:read`, `prospects:write`, `communications:read`, `research:write`, `opportunities:read`, `opportunities:write`, `tasks:read`, and `tasks:write`.

## Operations

| Method and path | Required scope | Purpose |
|---|---|---|
| `GET /v1/crm/companies?q=&limit=` | `companies:read` | Search existing client, lead, and prospect records. |
| `POST /v1/crm/companies` | `companies:write` | Create a canonical company identity. It does not create a client or opportunity pipeline record. |
| `PATCH /v1/crm/companies/{id}` | `companies:write` | Update canonical company identity and propagate name/industry changes to linked legacy CRM records. |
| `GET /v1/crm/contacts?q=&company_id=` | `contacts:read` | Search contacts and their company relationships. |
| `POST /v1/crm/contacts` | `contacts:write` | Add or link a contact. Existing email addresses match the existing contact rather than creating a duplicate. Multiple distinct contacts can be associated with one company. |
| `PATCH /v1/crm/contacts/{id}` | `contacts:write` | Update contact name, title, phone, notes, or primary email. Email evidence URLs must be HTTPS. |
| `GET /v1/crm/prospects?q=&limit=` | `prospects:read` | Search existing prospect research records, including company, fit, and campaign-opportunity text. |
| `POST /v1/crm/prospects` | `prospects:write` | Create one prospect research record linked to an existing canonical company. A record for that company must not already exist. |
| `PATCH /v1/crm/prospects/{id}` | `prospects:write` | Update prospect research fields; source URLs must use HTTPS. |
| `POST /v1/crm/research-notes` | `research:write` | Save a CRM activity note and optional HTTPS source with confidence. |
| `GET /v1/crm/communications?company_id={id}` | `communications:read` | Read Gmail communication metadata/snippets and existing Resend outreach records for a company. |
| `GET /v1/crm/communications?contact_id={id}` | `communications:read` | Read history for an individual contact. |
| `GET /v1/crm/opportunities` | `opportunities:read` | List lead records as opportunities. |
| `GET /v1/crm/opportunities/{id}` | `opportunities:read` | Read one existing lead/opportunity. |
| `PATCH /v1/crm/opportunities/{id}` | `opportunities:write` | Update stage, value, probability, follow-up date, status, or notes. Allowed stages remain the existing `New`, `Contacted`, `Proposal Sent`, and `Closed`. |
| `GET /v1/crm/follow-up-tasks?status=` | `tasks:read` | List open, completed, or canceled tasks. |
| `POST /v1/crm/follow-up-tasks` | `tasks:write` | Create a manual task, optionally linked to a contact. |
| `PATCH /v1/crm/follow-up-tasks/{id}` | `tasks:write` | Reschedule, assign, complete, reopen, or cancel a task. |

Canonical companies are additive identity records linked to the current `sales_records`; pipeline/client lifecycle remains in the existing dashboard model. Creating a canonical company does not create or promote a `sales_records` row. The Gmail sync stores selected header metadata only; it does not read message bodies or attachments. Gmail messages remain authoritative for Gmail sent/reply/draft status. A future sync must never mark a Gmail message sent because a draft was generated. Resend remains a separate provider and its existing `outreach_log`/activity behavior is preserved; Gmail sync records are stored in their own unique-message table and do not also create `sales_activities` entries.

## Recommended ChatGPT key

Start with `companies:read/write`, `contacts:read/write`, `prospects:read/write`, `communications:read`, `research:write`, `opportunities:read/write`, and `tasks:read/write`. The scope set can be narrowed if some operations are not wanted. Do not grant any email-send scope. Rotate/revoke the key independently of Jack and Cody's dashboard tokens.

The prospect resource is separate from canonical company identity and the lead opportunity pipeline. Creating it requires `company_id` for a previously found/created canonical company and writes an `entity_type='prospect'` record to the existing `sales_records` model, with a `sales_record_companies` link. It does not create a client or lead opportunity, and duplicate prospect records for the same canonical company return `409`. Creating a canonical company alone still does not create a prospect.

An importable OpenAPI 3.1 Action schema and Custom GPT setup/usage instructions are in `workers/sales-command-center/openapi/gpt-action.yaml` and `docs/custom-gpt-crm-action.md`. The schema points at the isolated staging Worker URL. It is a local artifact only; no Action has been created, no API key has been issued, and staging has not been deployed by this change.

## Follow-up automation boundary

The follow-up task API is available in Phase 1. Automatic task generation after the configured 3–5 business-day delay, plus cancellation/rescheduling when Gmail replies arrive, is Phase 2. Task generation will use a stable dedupe key tied to the source Gmail message/thread; a reply will update the open task rather than leave a stale reminder.
