# Gmail OAuth: lowest-cost compliant path to investigate

**Status:** Investigation only. Phase 1 does not implement Gmail OAuth, create OAuth clients, store tokens, request scopes, or deploy anything.

## What Google currently requires

- Gmail message search/read and draft listing can use `https://www.googleapis.com/auth/gmail.readonly`. It is the least-privileged persistent Gmail API scope that meets the approved sync needs; Google classifies it as **restricted**. Gmail's draft list endpoint also accepts this read-only scope. See [Gmail API scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes) and [draft-list authorization scopes](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/drafts/list).
- Google currently lists internal-use apps as an exception to OAuth verification when the app is used only within the same Google Workspace/Cloud Identity organization, the Google Cloud project is owned by that organization, and the consent screen is configured as Internal. This is not an automatic exemption merely because we call the integration private. Workspace admin approval may still be needed. See [Google's verification exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#internal_use_only) and [when verification is not needed](https://support.google.com/cloud/answer/13464323).
- The separate security-assessment guidance says apps that access restricted data from or through a third-party server must undergo a Google-approved security assessment, and says server storage/transmission of restricted data needs assessment. That requirement is distinct from OAuth app verification. Because this design uses a Cloudflare Worker and D1, the internal-use verification exception does **not clearly establish** that the server-side assessment can be skipped. See Google's [restricted-scope and assessment guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#security_assessment).

## Lowest-cost path, subject to Google's confirmation

1. Confirm `10ktakesmn.com` is a Google Workspace or Cloud Identity organization and that the project can be owned by that organization. Confirm `partnerships@10ktakesmn.com` is an actual Gmail/Workspace mailbox (not just a group or forwarding alias), and identify the Workspace administrator.
2. If those conditions hold, use an **Internal** OAuth app in the organization's Google Cloud project and request only `gmail.readonly`. Do not use domain-wide delegation, `gmail.modify`, `gmail.compose`, `gmail.send`, or `mail.google.com`; the requested integration only reads sent/received mail and draft metadata.
3. Before connecting the restricted scope to the Cloudflare Worker, ask Google OAuth Verification/Workspace support in writing whether this exact internal-only, one-mailbox use is exempt from the restricted-scope security assessment despite server-side access/storage. Do not enter production OAuth credentials or start syncing until that is resolved.
4. If Google confirms the exemption, proceed with the internal app and Workspace admin approval, keep only the minimum communication data, encrypt any retained message content with a Worker secret, and provide deletion/revocation controls. If Google says an assessment is required, estimate its cost first and obtain separate approval. Do not assume the low-cost path meets the assessment requirement.

## Lower-scope alternative and limitation

Google exposes Gmail add-on-only scopes that can reveal the current message during an add-on interaction, but those do not provide the scheduled mailbox polling, historical reconciliation, and reply tracking requested here. They are not a functional substitute for this integration. A service account also does not avoid the issue: Gmail is user mailbox data, not service-owned data, and domain-wide delegation adds administrator-level scope access.

## Phase 2 security design if authorized

- OAuth authorization code flow for the approved mailbox, with state/CSRF protections and offline access; no client-side tokens.
- OAuth client secret and data-encryption key held as Cloudflare Worker secrets. Refresh credentials encrypted before D1 storage; access tokens held only transiently in Worker memory.
- Start with bounded queries for the ten named brands and CRM-linked addresses, then use Gmail history IDs for incremental sync. No full-mailbox dump.
- Persist Gmail message/thread/draft IDs and limited metadata. If storing message body content is required, encrypt it at rest and retain only what the CRM feature needs. Ensure deletion and disconnect paths.
- Google OAuth is not assumed to incur an API usage charge here; the possible assessment is the material incremental cost and must be confirmed with Google before Phase 2.
