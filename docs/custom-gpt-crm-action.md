# Custom GPT CRM Action Setup

**Status: local preparation only.** The API schema and instructions are ready for review. No GPT Action has been created, no API key has been issued, and the staging Worker has not been deployed by this change.

## Before configuring the GPT

1. Deploy the reviewed Worker changes to the isolated staging environment only, after the staging deployment is explicitly approved.
2. Confirm the staging Worker URL shown in Cloudflare. The OpenAPI file currently uses `https://10k-takes-sales-command-center-staging.10ktakes.workers.dev`; replace it if Cloudflare reports a different account subdomain.
3. Provision a dedicated staging API key using the approved operator mechanism. Grant only the scopes the GPT needs. The key should be shown once, stored only in the GPT Action's authentication settings, and never pasted into instructions, chat messages, GitHub, or the public dashboard. No key provisioning endpoint is exposed to the GPT.
4. Keep Gmail disconnected for this milestone. The Action has no Gmail OAuth or send-email capability.

## GPT setup

1. In ChatGPT, create a private Custom GPT and open **Configure → Actions → Create new action**.
2. Import `workers/sales-command-center/openapi/gpt-action.yaml` as the schema. Confirm the server is the staging Worker, not production.
3. Set authentication to **API Key → Bearer** and enter the dedicated staging integration key.
4. Keep sharing set to **Only me** while validating. Do not publish or share the GPT until its access policy and action behavior are reviewed.
5. Add the operating instructions below, then use GPT Preview to test each operation against staging with synthetic or approved staging data.
6. Revoke the staging key when the test is finished or if it is exposed. Production requires a separate key, schema URL, explicit approval, and rollout.

## Operating instructions for the GPT

You are the 10K Hub partnership research assistant. Use the CRM Action for factual CRM operations. Search companies, contacts, and prospects before creating anything. Keep canonical companies, prospect research records, contacts, and lead opportunities distinct. Never create a client or opportunity merely because a company is researched.

When saving research, use only facts supported by a source the user supplied or an accessible, credible source. Include the HTTPS source URL and an appropriate confidence value. Do not invent contact names, titles, email addresses, company details, or evidence. Treat an email address as unverified unless the CRM record includes its verification source/confidence or the user confirms it.

Before any create or update operation, show the intended company/contact/prospect/opportunity/task changes and ask the user to approve them. Do not write until approval. For each distinct write, generate a fresh random `Idempotency-Key` of at least 12 characters; reuse that key only to retry the exact same request. Search first and resolve possible duplicates before writing.

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
