# Gmail First Live Test Readiness

**Staging prepared; Gmail remains disconnected.** No OAuth credentials were created, no prospect records were imported, and production was not touched.

### Staging environment created

- D1: `10k-takes-sales-command-center-staging` (`0b960090-30e9-43ed-bd15-1ad7dfe05f81`)
- Worker: `10k-takes-sales-command-center-staging` at `https://10k-takes-sales-command-center-staging.10ktakes.workers.dev`
- Staging Worker version: `5beb7dc8-fa89-48a7-ac08-6077db7b8e91`
- D1 was initialized from the repository baseline `schema.sql`, then migrations 0002–0006 were applied in order and recorded in `d1_migrations`.
- The deployed staging Worker is bound only to the staging D1, the Workers AI binding, and the public read origin. It has the `*/15 * * * *` cron trigger. The top-level production D1 binding was not included in the staging deployment (Wrangler dry-run binding preview confirmed this).
- No Gmail OAuth variables/secrets are configured. `sales_gmail_oauth_credentials` and `sales_gmail_sync_state` are empty, so cron invocations will skip rather than poll Gmail.
- Baseline CRM counts: `sales_records=0`, `sales_companies=0`, `sales_contacts=0`, `sales_communications=0`, `sales_follow_up_tasks=0`, Gmail sync states `=0`. D1 also contains only the baseline user rows/settings/source rows inserted by the schema/migrations.
- A short-lived staging-only credential with `companies:read` was created as a hash, used for the importer's dry run, and deleted immediately afterward. No live CRM records were created.

## Historical contact reconciliation

The evidence-backed contact worksheet is `workers/sales-command-center/data/gmail_reconciliation_contacts_template.csv`. It contains 16 rows across the ten requested brands. It uses the Gmail messages/replies currently found in `partnerships@10ktakesmn.com`; the source URL is the corresponding Gmail message. Names shown only in outbound greetings are kept to the first name. Titles are blank unless a message states one. The three Kwik Trip referrals are role labels, not asserted job titles. SeatGeek press, SCHEELS affiliate, and Buffalo Wild Wings PR addresses are included as team inbox references but have no contact name, so the importer skips them.

The importer's dry run was subsequently run against the initialized staging CRM API with a temporary staging-only read credential. It found **0 existing matches, 0 ambiguous records, 10 proposed company additions, 13 named-contact additions/links, and 3 unnamed team inboxes skipped**. Because the staging CRM begins empty, the named-contact actions are proposed as create/link operations under the ten companies. The importer made no writes. This is not a production match report; production must be checked separately in an approved rollout.

No title, surname, company website, or industry was inferred from an email local-part or the conversation. Email addresses are included only where they appeared in actual mailbox messages (sent recipients, replies, or explicit referrals). A supplied address by itself is not treated as independent verification.

## Google Cloud and Workspace setup checklist

Do these steps only after approval to configure a **staging** OAuth client. Do not use a production client or connect the mailbox yet.

1. Ask the Workspace administrator to confirm that `partnerships@10ktakesmn.com` is a real, licensed Workspace mailbox (not only an alias or group), that the Cloud project is in the `10ktakesmn.com` Workspace/Cloud Identity organization, and that user-authorized Gmail API access is permitted by API controls.
2. In Google Cloud Console, select/create a project owned by that organization. Open **APIs & Services → Library**, find **Gmail API**, and enable it.
3. Open **Google Auth Platform → Branding**. Set the internal app name, support email, developer contact, and any organization/domain details required by the console.
4. Under **Audience**, select **Internal** only if the project belongs to that Workspace organization and every allowed user is in it. An Internal app is not available to consumer Gmail accounts or users outside that organization. Internal apps do not use an External test-user list; instead the Workspace administrator may still need to trust/allow the app in **Admin console → Security → Access and data control → API controls → App access control**.
5. Under **Data Access**, request only `https://www.googleapis.com/auth/gmail.metadata`. The current Worker sync reads message headers/labels and thread metadata, not bodies or attachments. Do not add `gmail.readonly` unless requirements change.
6. Under **Clients**, create an OAuth client of type **Web application**. Add this exact authorized redirect URI (replace host only if the staging Worker host differs):

   `https://10k-takes-sales-command-center.10ktakes.workers.dev/v1/sales/gmail/callback`

   The redirect route is defined in `workers/sales-command-center/src/gmail.ts`. This is server-side OAuth, so no JavaScript origin is required. If a separate staging Worker is created, register its callback URI instead. Keep the client secret out of files and screenshots.
7. Set staging Worker runtime variables `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_REDIRECT_URI`. Set secrets `GOOGLE_OAUTH_CLIENT_SECRET` and `GMAIL_TOKEN_ENCRYPTION_KEY`. Generate the encryption key from 32 cryptographically random bytes and encode as unpadded base64url; preserve it in the approved secret manager because rotating it without re-encrypting the stored refresh token requires reconnecting. These are Worker secrets/variables, not GitHub Actions secrets. Never place refresh tokens or client secrets in GitHub Pages.
8. Do not create a service account or enable domain-wide delegation. The current design uses user-consented OAuth for one mailbox.
9. After all approvals and staging deployment, connect only the exact `partnerships@10ktakesmn.com` mailbox and verify the consent page lists the metadata scope.

### Internal versus External and restricted-scope gate

`gmail.metadata` is classified as a **restricted** scope by Google's Gmail scope table. Google documents an Internal-app exception to OAuth app verification when the app is limited to users of the owning Workspace/Cloud Identity organization. That exception is not available merely because the use is private; the project organization and audience must meet Google's conditions. If either condition fails, the app must be External. An External app left in Testing has a seven-day refresh-token lifetime for restricted-scope grants, so it is unsuitable for unattended 15-minute polling.

The public official material is not fully clear on whether the Internal verification exception also waives the server-side restricted-data security assessment for data routed through a Cloudflare Worker/D1. The restricted-scope verification guidance describes annual assessment for third-party-server access, while Google's Workspace user-data policy describes exceptions for apps used only within an organization. Treat the CASA/assessment exemption as **unconfirmed** until Google gives a written determination for this architecture or the Cloud console explicitly confirms it. Workspace admin permission is a separate requirement. Do not connect even staging Gmail until the Workspace admin approves and the assessment question is resolved for the chosen app state.

Official sources:

- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted-scope verification and security assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [OAuth app state and internal apps](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Workspace user-data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail API setup](https://developers.google.com/workspace/gmail/api/quickstart/js)

## Staging readiness

The local source contains the Gmail metadata sync, migration files, OAuth callback, `*/15 * * * *` cron declaration, and sanitized `gmail_sync_cron` logs. Staging D1 and Worker are now deployed as listed above; all five tracked migrations show applied, and schema queries confirmed canonical companies, contacts, communications, follow-up tasks, OAuth credentials/state, and sync queue tables. Wrangler's staging deploy output confirmed the 15-minute trigger. The old preview D1 is separate from this newly created staging D1 and remains uninitialized; neither it nor production was modified for this setup.

## First live staging sync checks

1. Back up staging D1. Record migration ledger and counts for `sales_records`, contacts, communications, activities, and Resend `outreach_log`.
2. Deploy only staging. Verify `GET /v1/sales/gmail/status` is disconnected before OAuth, and existing `/v1/sales/*` behavior still works.
3. Configure staging OAuth variables/secrets; connect the intended mailbox after Workspace/OAuth approval. Confirm status shows only `gmail.metadata` and the correct mailbox.
4. Import the reviewed CSV into staging only after a CRM-backed dry run. Confirm the same-brand multi-contact rows link to one company, unnamed team inboxes are not created as people, and a second dry run proposes no duplicates or overwrites.
5. Manually sync a known sent message and confirm metadata, direction, date, thread/message IDs, and matched company/contact. Confirm a received reply is linked to the same thread/company and updates follow-up state.
6. Confirm a Gmail draft appears as draft metadata only. Confirm no body/attachment content is stored or displayed.
7. Confirm an unrelated sender with no known contact, domain, or linked thread is discarded. Confirm a known-company domain with unknown person remains company-level only.
8. Run sync twice. Message/thread uniqueness should prevent duplicate activities. Confirm a Resend message appears once in Communications and Gmail sync does not duplicate a Resend activity.
9. Confirm an outbound email can create an idempotent follow-up task due after the configured business-day delay; a reply cancels/updates the open task. No email sending is enabled by Gmail sync.
10. Disconnect and reconnect in staging. Verify the grant is revoked/cleared, historical CRM records remain, and reconnecting the same mailbox resumes safely without duplicates.
11. Observe at least four staging cron ticks (about one hour). `last_attempt_at` should advance roughly every 15 minutes; successful ticks advance `last_success_at`, sanitized counts should be plausible, and pending work should drain.

## Sanitized logs and recovery

In Cloudflare Dashboard, open the **staging** Worker → **Observability / Logs** and filter for `gmail_sync_cron`. The event should expose only timestamp, outcome (`success`, `error`, `skipped_not_connected`), and counts; it must not include OAuth tokens, addresses, message subjects/bodies, or headers. Also inspect staging D1:

```sql
SELECT mailbox_email, status, last_attempt_at, last_success_at,
       error_summary, last_sync_counts_json, initial_sync_complete
FROM sales_gmail_sync_state;
```

Recovery: for `skipped_not_connected`, finish the approved staging OAuth connection; for expired/revoked grant or 401, reconnect the mailbox; for `admin_policy_enforced`, ask the Workspace administrator to trust/allow the app; for transient 429/5xx, allow the next scheduled tick/retry and check whether counts progress. If the Gmail history cursor is invalid, use the dashboard's authorized history reconciliation action and verify idempotency before rerunning. Do not delete messages or sync state to clear an error. If repeated failures persist, preserve sanitized error/time/count evidence, pause the staging trigger, correct config, then resume and compare state. Do not copy tokens or raw message content into logs or support tickets.

## Approval boundary

This milestone ends with staging provisioned and the import preview reviewed; Gmail remains disconnected. Before any staging mailbox connection, resolve the Internal/External and security-assessment questions and get the required Workspace approval. A separate explicit approval is still required before live Gmail synchronization. Prospect-specific API endpoints and the Custom GPT Action remain a later phase.
