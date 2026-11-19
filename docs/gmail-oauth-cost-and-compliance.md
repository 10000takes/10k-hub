# Gmail OAuth: lowest-cost compliant path to investigate

**Status:** OAuth design decision for Phase 2. Local implementation requests `gmail.metadata`; no OAuth client, Gmail API enablement, mailbox authorization, or deployment was performed.

## What Google currently requires

- The local sync uses `https://www.googleapis.com/auth/gmail.metadata`, which Google classifies as **restricted**. It is narrower than `gmail.readonly` and permits message IDs, labels, and selected headers using `messages.list` and `messages.get?format=metadata`; the metadata scope does not allow the `q` search parameter. Gmail's dedicated drafts resource is not used; drafts are identified from the `DRAFT` message label. See [Gmail API scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), and [messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).
- Google currently lists internal-use apps as an exception to OAuth verification when the app is used only within the same Google Workspace/Cloud Identity organization, the Google Cloud project is owned by that organization, and the consent screen is configured as Internal. This is not an automatic exemption merely because we call the integration private. Workspace admin approval may still be needed. See [Google's verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#internal_use_only) and [when verification is not needed](https://support.google.com/cloud/answer/13464323).
- The separate security-assessment guidance says apps that access restricted data from or through a third-party server must undergo a Google-approved security assessment, and says server storage/transmission of restricted data needs assessment. That requirement is distinct from OAuth app verification. Because this design uses a Cloudflare Worker and D1, the internal-use verification exception does **not clearly establish** that the server-side assessment can be skipped. See Google's [restricted-scope and assessment guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#security_assessment).

## Lowest-cost path, subject to Google's confirmation

1. Confirm `10ktakesmn.com` is a Google Workspace or Cloud Identity organization and that the project can be owned by that organization. Confirm `partnerships@10ktakesmn.com` is an actual Gmail/Workspace mailbox (not just a group or forwarding alias), and identify the Workspace administrator.
2. If those conditions hold, use an **Internal** OAuth app in the organization's Google Cloud project and request only `gmail.metadata`. Do not use domain-wide delegation, `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.send`, or `mail.google.com` unless Google confirms this metadata scope cannot support the approved functionality.
3. Follow the written Google guidance already received for the Internal-app route, and ask the Workspace administrator to confirm mailbox and project organization eligibility and any admin approval. If Google's response does not clearly resolve server-side assessment treatment, ask for confirmation before connecting the restricted scope.
4. If additional approval or assessment is required, estimate its cost before any credentials or mailbox access are configured. The local code does not claim that a Google exception or assessment has been granted.

## Lower-scope alternative and limitation

Google exposes Gmail add-on-only scopes that can reveal the current message during an add-on interaction, but those do not provide the scheduled mailbox polling, historical reconciliation, and reply tracking requested here. They are not a functional substitute for this integration. A service account also does not avoid the issue: Gmail is user mailbox data, not service-owned data, and domain-wide delegation adds administrator-level scope access.

## Phase 2 security design if authorized

- OAuth authorization code flow for the approved mailbox, with state/CSRF protections and offline access; no client-side tokens.
- OAuth client secret and data-encryption key held as Cloudflare Worker secrets. Refresh credentials encrypted before D1 storage; access tokens held only transiently in Worker memory.
- Because `gmail.metadata` does not support Gmail's `q` parameter, initial reconciliation pages message IDs and examines selected headers. The implementation stores only CRM-linked messages and discards unmatched messages; later changes use Gmail history IDs. It does not read or store bodies or attachments.
- Persist Gmail message/thread IDs, labels, selected headers, and limited CRM linkage. Drafts are tracked from the `DRAFT` label on their message, without calling the broader-scope Gmail Drafts resource. Ensure disconnect controls.
- Google OAuth is not assumed to incur an API usage charge here; any assessment/approval obligations remain subject to Google's written guidance and Workspace administrator confirmation.
