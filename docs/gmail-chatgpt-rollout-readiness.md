# Gmail Reconciliation and ChatGPT CRM Rollout Readiness

**Status: local preparation only.** No OAuth client, Gmail API enablement, mailbox connection, secret update, remote D1 migration, Worker deployment, or email sending was performed.

## 1. Gmail matching audit

`src/gmail.ts` matches a message using normalized sender/recipient email addresses against `sales_contact_emails`. If there is no exact contact match, it may attach the message to a canonical company when an external email domain exactly matches a company website host already in D1. A message in a previously linked Gmail thread inherits that thread's CRM link. If none of those checks match, the message is counted as unmatched and discarded; the sync does **not** create a contact or persist unrelated mailbox metadata. This safeguard is intentional.

The audit found a defect in that fallback: a company-domain match without a contact was being overwritten by an empty thread lookup. The lookup now runs only when neither a contact nor a company is already matched. A regression test verifies the unknown contact is retained at company level while a wholly unrelated message is still discarded.

Therefore, a message to a person absent from D1 is **not always discarded**: it can remain linked at company level by a known website domain or a previously linked thread. It is discarded when neither safe relationship exists. Populate canonical company websites and reviewed contacts before the first historical scan to improve attribution; do not loosen matching to fuzzy names or unknown domains.

The dashboard already combines Gmail communication metadata and Resend `outreach_log` rows in Communications. Resend sending also records an `email_sent` row in the CRM activity timeline. The local UI now omits `email_sent` from that timeline while retaining other manually logged activities, so a Resend send appears once in Communications. Gmail sync writes only `sales_communications`, not `sales_activities`. Gmail history API queries now exclude rows with `deleted_at` set. Tests cover the deleted-row filter and provider separation.

### What the current Gmail implementation displays

- **Sent messages:** Gmail metadata headers plus Gmail's `SENT` state; Resend sends from `outreach_log`.
- **Received replies:** header metadata, linked to the contact/company/thread where matching evidence exists.
- **Drafts:** metadata headers with a Gmail `DRAFT` label. This does not show draft body text or allow editing in 10K Hub.
- **Message bodies and attachments:** not fetched or stored. The current implementation asks for `gmail.metadata`, which is restricted but narrower than `gmail.readonly`.

Thus the local test suite verifies representative sent, received, and DRAFT-labeled rows display in CRM Communications, as well as Resend entries without duplicate email activity. It does not verify a real mailbox until OAuth is configured and a mailbox is connected. If the intended product requirement is to read draft/body content, stop before connection: that would require a scope and compliance review beyond the current metadata-only implementation.

## 2. Historical import for the first ten brands

The supplied/repository context identifies these brands but does not include verified individual contact names, emails, or source URLs: Jack Link's, Kwik Trip, Gametime, SeatGeek, SCHEELS, Buffalo Wild Wings, Raising Cane's, Gatorade, CELSIUS, and Jersey Mike's. No contacts are fabricated or imported from names alone.

The CSV template is `workers/sales-command-center/data/gmail_reconciliation_contacts_template.csv`. Put one row per contact; repeat the company name for multiple contacts at the same brand. Contact rows are accepted only when they include a name, email, and HTTPS evidence URL. The import records low confidence pending human review. Empty contact columns are permitted and allow company identity reconciliation first.

The importer at `workers/sales-command-center/scripts/import_gmail_reconciliation.py` is dry-run by default. It uses the existing scoped CRM API over HTTPS, performs exact-name checks, stops on possible ambiguous company matches, uses stable idempotency keys, never calls PATCH, and never overwrites existing company/contact profile fields. If an email already exists, the API returns the existing contact and adds the company relationship without replacing that contact's name/title. It creates canonical company/contact identity only; it does not create a client or opportunity in `sales_records`.

From `workers/sales-command-center`, after Phase 1/2 is deployed to a **staging Worker and staging D1** and a scoped temporary key is issued there:

```sh
export CRM_IMPORT_WORKER_URL="https://<staging-worker-host>"
export CRM_IMPORT_TOKEN="<staging-scoped-key>"
python3 scripts/import_gmail_reconciliation.py data/gmail_reconciliation_contacts_template.csv
```

Review the dry-run output. Then fill in the actual evidence-backed contacts and run the dry-run again. Only after reviewing every company match and contact row, explicitly apply to staging:

```sh
python3 scripts/import_gmail_reconciliation.py data/gmail_reconciliation_contacts_template.csv --apply
```

Use a short-lived key scoped to `companies:read`, `companies:write`, `contacts:write`; `contacts:read` is not needed by this importer. The script never prints the bearer key. Do not use a production key for the first import. The currently committed template includes the ten brand names and blank contacts; it is a template, not imported production data.

## 3. Google Cloud OAuth setup (only after explicit rollout approval)

These are setup instructions, not actions already taken.

1. In Google Cloud Console, select a project owned by the `10ktakesmn.com` Workspace organization (or create one there). Confirm with the Workspace administrator that `partnerships@10ktakesmn.com` is a real, licensed mailbox account rather than only an alias/group and that users are allowed to authorize this project/app.
2. Open **Google Auth Platform → Branding** (or the OAuth consent-screen page in the current console), set the app name, user support email, developer contact, and any required domain/privacy details.
3. Set **Audience / User type = Internal** only if the project belongs to the Workspace organization and the app is restricted to its members. Do not choose External just to get past an admin restriction. Internal audience is not itself proof of administrator authorization.
4. Declare only the scope used by the current code: `https://www.googleapis.com/auth/gmail.metadata`. Do not add `gmail.readonly` unless the product requirement changes and its added access/compliance consequences are accepted.
5. Open **APIs & Services → Library → Gmail API → Enable** for this project.
6. Open **Google Auth Platform → Clients → Create client → Web application**. Add one **Authorized redirect URI** exactly equal to the deployed Worker URL plus `/v1/sales/gmail/callback`, for example `https://<worker-host>/v1/sales/gmail/callback`. Do not add a JavaScript origin; the OAuth callback is server-side. Keep the generated client ID and secret private.
7. On the Content Intelligence/Sales Command Center Worker, set `GOOGLE_OAUTH_CLIENT_ID` as a plain-text variable; set `GOOGLE_OAUTH_REDIRECT_URI` to the exact callback above as a variable; set `GOOGLE_OAUTH_CLIENT_SECRET` and `GMAIL_TOKEN_ENCRYPTION_KEY` as Worker secrets. Generate the latter from 32 random bytes and base64url-encode it. Keep the same key backed up securely; rotating it without re-encrypting the stored refresh token requires reconnecting Gmail. Do not put any of these secrets in GitHub Pages, source code, a committed `wrangler.jsonc`, or a GitHub Actions variable.
8. Ask the Workspace administrator to review **Admin console → Security → Access and data control → API controls → App access control** and allow/trust the OAuth app if organizational policy blocks it. Do not use domain-wide delegation; the implementation is user-authorized OAuth for one mailbox.
9. Before Jack connects the mailbox, confirm the displayed app identity and requested scope, verify the exact target mailbox, and use the staging Worker first.

### Verification and security-assessment question

Confirmed from Google's current docs: `gmail.metadata` is a **restricted** Gmail scope; OAuth apps requesting restricted scopes generally require restricted-scope verification unless an exception applies. Google documents internal-use exceptions when an app is restricted to users in the Workspace/Cloud Identity organization. The OAuth app must be configured Internal and the Cloud project must belong to that organization for this route to fit. Workspace administrators can still block authorization.

The pasted note titled “From Google” in the project context asserts that Internal use exempts both verification and CASA. That text is a summary citing a mix of official and third-party pages, not a direct Google support determination. Google's current official scope table says restricted-scope data stored on or transmitted through servers requires an assessment; its restricted-scope verification page says every app accessing restricted data from/through a third-party server must undergo an annual assessment, while also listing internal use among verification exceptions. The official public text does not cleanly state that the **verification exception also waives the server-side security assessment** for this one-mailbox Cloudflare Worker. So: Internal is the chosen low-cost setup direction, and OAuth verification appears exempt if the Workspace/project criteria are met; CASA exemption remains unconfirmed by authoritative evidence in the supplied note. Before connecting the real mailbox, retain a direct Google support determination (or a clear Google Cloud Console notice for this exact Internal project) and administrator confirmation. If Google confirms the exemption, no third-party assessment should be budgeted for this internal-only deployment; if it does not, pause and price the required assessment before proceeding.

Official references:

- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification and security assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [OAuth app state and internal apps](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Workspace user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail API enablement / quickstart](https://developers.google.com/workspace/gmail/api/quickstart/js)

## 4. ChatGPT-to-10K Hub integration design (next phase)

### Recommended approach

Use a private Custom GPT configured with an **Action** and an explicit OpenAPI schema. GPT Actions require an API description/schema and configured authentication; ChatGPT does not automatically call arbitrary Cloudflare Worker URLs. Configure API-key/Bearer authentication for server-to-server calls. Do not configure Gmail OAuth in ChatGPT; Gmail remains connected only to the Worker.

The next phase should publish a narrowly scoped key through a Jack-only provisioning/revocation path (or a controlled operator CLI); raw key shown once, D1 stores only its hash. Use a distinct key for each GPT/environment, short expiration, and modest per-minute limit. Grant only `companies:read/write`, `contacts:read/write`, `research:write`, `communications:read`, `opportunities:read/write`, and `tasks:read/write` as needed. No send-email scope or send endpoint. Do not store the key in a GPT prompt or instructions; place it only in the Action's authentication configuration. Apply workspace/domain action allowlisting if the ChatGPT plan exposes/enforces it.

The existing `/v1/crm/*` API already covers most operations, with request validation, narrow scopes, rate limiting, audit records, and idempotency for writes. The prospective contract includes:

| Capability | Operation |
|---|---|
| Search companies and contacts | `GET /v1/crm/companies?q=&limit=`; `GET /v1/crm/contacts?q=&company_id=` |
| Create/update canonical companies and contacts | `POST/PATCH /v1/crm/companies[/{id}]`; `POST/PATCH /v1/crm/contacts[/{id}]` |
| Research notes | `POST /v1/crm/research-notes` with HTTPS source and confidence |
| Communication history | `GET /v1/crm/communications?company_id=` or `?contact_id=` |
| Opportunities | `GET /v1/crm/opportunities[/{id}]`; `PATCH /v1/crm/opportunities/{id}` (existing `sales_records` lead model) |
| Follow-up tasks | `GET/POST /v1/crm/follow-up-tasks`; `PATCH /v1/crm/follow-up-tasks/{id}` |

Before GPT setup, add a purpose-built prospect search/create/update operation over existing prospect records. The current companies search gives canonical company identities and `linked_record_count`/`record_types`; opportunities cover `entity_type='lead'`, not all prospect records. Keep companies (identity) distinct from opportunities and prospects, and do not change the existing `sales_records` model. Produce a reviewed OpenAPI document that marks every write with required `Idempotency-Key`, explicit request/response schemas, and no raw database access. Make ChatGPT confirm before any write with meaningful side effects; human approval remains required for all outbound messages, and this API has no send operation.

OpenAI's setup guide: [Configuring actions in GPTs](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts). Action authentication and schema are configured in the GPT editor; test each operation in Preview before sharing the GPT privately.

## 5. Staging and production rollout checklist

### Staging sequence

1. Preserve the currently deployed Worker version and take/verify a D1 backup. Use an isolated staging D1, Worker name, OAuth project/client and non-production API key.
2. Apply migrations in Wrangler's tracked order: existing schema → `0005_crm_integration_foundation.sql` (if not already applied) → `0006_gmail_internal_metadata_sync.sql`. Confirm the migration ledger, table/index list, and pre/post counts for `sales_records`, company/contact tables, activities and outreach logs. Never rerun 0006 manually outside the migration ledger.
3. Deploy the Worker to staging only. Confirm `/v1/crm/*` scopes, auth failures, rate limits, idempotency replay, audit rows, and the existing `/v1/sales/*` API.
4. Use the CSV importer in dry-run mode, resolve ambiguous matches, add evidence-backed contacts (one row per person), inspect output, then apply to staging. Check two or more contacts can link to the same company and rerunning creates no duplicates or profile overwrites.
5. After OAuth and assessment/admin approval, configure staging secrets, connect the exact mailbox, and verify status reports `gmail.metadata` only. Run bounded sync and compare the UI with Gmail for known sent, received reply, and draft metadata; confirm Resend sends appear once and manual activities remain visible.
6. For match review, test one known-contact email, one known-company-domain/unknown-contact email, one reply in a linked thread, and one unrelated email. The unrelated message must not appear in D1; the first three should link only through the documented evidence paths. Check no bodies/attachments were fetched.
7. Verify follow-up task idempotency and reply cancellation, then verify each scheduled tick and counts for at least an hour (four ticks). Do not consider initial reconciliation complete while pending items remain.
8. Test the Custom GPT Action against staging only after the prospect endpoint and scoped key are ready. Test search, company/contact write, research note provenance, communication reads, opportunity update, task lifecycle, rate limit, missing idempotency key, revoked/expired key, and audit trail.

### 15-minute sync verification

The Worker config declares `*/15 * * * *`. Once staging is connected, verify both:

- **Worker logs:** Cloudflare dashboard → Worker → Logs/Observability. Each scheduled invocation emits a sanitized `gmail_sync_cron` event (`success`, `error`, or `skipped_not_connected`) with time and counts, but no message content, email addresses, tokens, or OAuth data.
- **D1 state:** in the staging D1 console, run:

```sql
SELECT mailbox_email, status, last_attempt_at, last_success_at,
       error_summary, last_sync_counts_json, initial_sync_complete
FROM sales_gmail_sync_state;
```

For a connected steady-state mailbox, `last_attempt_at` should advance every ~15 minutes and `last_success_at` should advance when a tick completes; `status` should be connected (or syncing while a bounded backlog remains), `error_summary` should be empty, and `pending` should eventually drain. A log event of `skipped_not_connected`, a stale attempt beyond 20–30 minutes, repeated error status, or an ever-growing pending count is an alert condition. Configure a Cloudflare alert/notification or external monitor before production if automatic alerting is required; no alert destination is configured by this repository.

### Production gate and rollback

- Do not proceed until OAuth scope/assessment and Workspace admin authorization are resolved in writing, staging tests pass, contacts/domain evidence is reviewed, and Jack approves the rollout.
- Back up production D1 and record current migration state and deployed Worker version. Apply the additive migration once, deploy Worker, then set production OAuth variables/secrets and connect the mailbox only after the setup gate. Deploy the updated dashboard separately.
- Verify CRM records, communication counts, provider uniqueness, audit events, and scheduled runs; retain logs and backup. Reconcile the ten companies against Gmail using reviewed contact rows, and inspect every unmatched count before declaring completion.
- If the Worker/API fails, redeploy the previous Worker version and leave additive tables intact. Do not drop the new tables or erase communication rows. If OAuth is compromised or unwanted, disconnect/revoke the Google grant and rotate/reconnect under a reviewed encryption-key procedure; keep CRM history. Revoke integration keys independently. No rollback should send or replay outbound messages.

## Validation performed for this preparation

- Worker tests: `npm test` — 12 passed.
- TypeScript: `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM src/index.ts src/gmail.ts` — passed.
- Python import utility tests: `python3 -m unittest scripts/test_import_gmail_reconciliation.py` — see current run result in the handoff summary.
- `git diff --check` — passed at the time of the test run; rerun after final edits.
