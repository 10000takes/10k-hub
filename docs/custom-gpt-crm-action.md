# Custom GPT CRM Action Setup

**Staging API deployed.** Worker version `78aa66eb-5592-4772-9ace-4477aedd1508` is live at `https://10k-takes-sales-command-center-staging.10ktakes.workers.dev`. The private staging key is provisioned and expires after 30 days. No GPT Action has been created and Gmail remains disconnected.

## Before configuring the GPT

1. The staging Worker URL is confirmed as `https://10k-takes-sales-command-center-staging.10ktakes.workers.dev`; the imported OpenAPI schema already uses it.
2. A dedicated key is stored only as a SHA-256 hash in staging D1. It expires **December 24, 2026 at 11:21 AM Central** and is limited to 30 requests per minute. Its scopes cover company/contact/prospect read and write, research-note write, communication read, opportunity read/write, and task read/write. It cannot use the separate dashboard API, Gmail-management routes, or email-send route. No key provisioning endpoint is exposed to the GPT.
3. The one-time local copy is in `/private/tmp/10khub-crm-action-staging-key.txt` with owner-only file permissions. On the trusted Mac, run `pbcopy < /private/tmp/10khub-crm-action-staging-key.txt` and paste it only into the Action Authentication settings below. Do not put it in GPT instructions, chat, GitHub, or the public dashboard. Delete the file after saving the key in ChatGPT; the D1 hash remains, and recovery then requires issuing a replacement key.
4. Keep Gmail disconnected during testing. The Action has no Gmail OAuth or send-email capability.

## GPT setup

**Current product availability check:** OpenAI's Help Center currently says personal ChatGPT accounts (Free, Go, Plus, and Pro) cannot create or publish a new Custom GPT. For affected Enterprise workspaces, new GPT creation ended October 26, 2026; existing unmigrated GPTs are scheduled to become read-only after December 11, 2026. Check your workspace notice and account permissions before using the Action path below. These restrictions make the Custom GPT Action a short-lived or unavailable path for some accounts.

1. Open the GPT editor in ChatGPT on the web, if your account/workspace still allows creating or editing one.
2. If creation or editing is available, create a private GPT named **10K Takes AI Partnership Consultant** and open **Configure → Actions → Create new action**.
3. Import `workers/sales-command-center/openapi/gpt-action.yaml`. Confirm the server reads `https://10k-takes-sales-command-center-staging.10ktakes.workers.dev`.
4. Under **Authentication**, select **API Key**, choose **Bearer**, and paste the staging key from the clipboard. Save the Action.
5. Paste the operating instructions below into the GPT's **Instructions** field.
6. Enable the GPT's **Web Search** capability so it can research public partner information and cite sources. Keep the Action as its only connected CRM system; this Action cannot be paired with Gmail as an app inside the same Custom GPT.
7. Set sharing to **Only me**. Do not publish or share it during staging validation.
8. In **Preview**, test company/prospect/contact search, synthetic prospect reads, history reads, and task reads first. For any test write, review the proposed change before approving it. The OpenAPI schema marks all writes as requiring an `Idempotency-Key`.
9. Revoke the staging key when testing is complete, or sooner if it is exposed. Production requires a separate key and explicit approval.

To revoke the current key immediately, open Cloudflare D1 → `10k-takes-sales-command-center-staging` → Console and run:

```sql
UPDATE sales_crm_api_credentials
SET revoked_at = CURRENT_TIMESTAMP
WHERE id = '99b928f7-e8b4-4699-82cb-56aa90d7d7ca'
  AND revoked_at IS NULL;
```

Do not run this against production. The key expires automatically on December 24, 2026 at 11:21 AM Central even if it is not manually revoked.

Official OpenAI setup references: [Custom GPT Action configuration](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts) and [GPT creation availability](https://help.openai.com/en/articles/8554397-creating-and-editing-gpts).

## Operating instructions for the GPT

You are the 10K Takes AI Partnership Consultant. The 10K Hub is the authoritative CRM. Use the CRM Action for CRM facts and changes. Research potential partners using reliable public sources; assess audience fit, brand alignment, campaign opportunity, geography, and available evidence. Clearly separate verified facts from hypotheses and unknowns. Do not invent budget, decision-maker, interest, or qualification claims. Search canonical companies, prospects, contacts, and existing lead opportunities before proposing any new record. Keep companies, prospects, contacts, leads, and clients distinct. Never create a client or opportunity merely because a company is researched.

When saving research, use only facts supported by a source the user supplied or an accessible, credible source. Include the HTTPS source URL and an appropriate confidence value. Do not invent contact names, titles, email addresses, company details, or evidence. Treat an email address as unverified unless the CRM record includes its verification source/confidence or the user confirms it.

Before suggesting outreach, search the company's CRM communication history and linked contacts; identify recent messages, replies, drafts, and Resend records by their provider/status. Do not recommend duplicate outreach when a recent message is unanswered; explain what prior outreach was found and suggest an appropriate next step. Draft personalized outreach based on supported facts, but do not send it. Before any create or update operation, show the intended company/contact/prospect/opportunity/task changes and ask the user to approve them. Do not write until approval. For each distinct write, generate a fresh random `Idempotency-Key` of at least 12 characters; reuse that key only to retry the exact same request. Search first and resolve possible duplicates before writing.

Read communications only when asked or when needed to answer an outreach-history question. Distinguish Gmail messages from Resend communications and report their provider and status accurately. A draft is not a sent email. Never send, schedule, or imply that an email was sent; all outbound messages require manual human approval and sending outside this Action.

Use the existing opportunity stages exactly: `New`, `Contacted`, `Proposal Sent`, and `Closed`. Do not claim a follow-up task is complete unless its CRM status says completed. If a requested change is ambiguous, ask the user before writing.

## Available Action capabilities

- Search and maintain canonical companies.
- Search and maintain separate contacts, including multiple contacts at one company.
- Search and maintain prospect research records linked to canonical companies.
- Save research notes with source provenance.
- Retrieve Gmail and Resend communication metadata/history.
- Read and update existing `sales_records` lead opportunities.
- Create, list, reschedule, complete, reopen, or cancel follow-up tasks.

## Staging acceptance checks

- Missing/invalid key returns unauthorized; a key without an operation's scope is denied.
- Every write rejects a missing idempotency key; exact retries do not create duplicates.
- Company/contact deduplication and multiple contacts at one company behave as expected.
- Prospect create requires an existing canonical company and rejects an existing prospect for that company; prospect updates do not mutate opportunity stages or client records.
- Communication history distinguishes Gmail from Resend and does not claim a draft was sent.
- Opportunity updates preserve the existing lead model and allowed stages.
- Follow-up task create/update actions retain audit records and correctly handle status/date changes.
- Check Worker audit events and sanitized logs. Do not include credentials or email content in prompts or logs.

## Gmail drafting boundary

This CRM Action does not create Gmail drafts or send messages. Its CRM communication-history operation only reads metadata/snippets; staging currently has no connected mailbox. OpenAI's current Custom GPT guidance says a GPT can use either Actions or Apps, not both, so this Action cannot simply be combined with a Gmail app inside the same Custom GPT. The simplest safe workflow is to use the CRM Action to review contacts and prior outreach, have the GPT produce a personalized draft in chat, then copy it into Gmail and review/send it yourself. A later direct-draft feature would need a separately reviewed, draft-only Gmail capability; it must not expose a send operation.

If the account is eligible for custom MCP apps instead of Custom GPT Actions, OpenAI currently documents using multiple apps in one conversation. That is a separate integration path and plan/workspace availability must be checked. Do not reuse this Bearer key in a different connector or give a Gmail app permission to send if manual approval in Gmail is the desired control.
