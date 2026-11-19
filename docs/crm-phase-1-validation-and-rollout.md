# CRM Phase 1 Validation and Rollback

Phase 1 is additive and has only been implemented and validated locally. No Worker deployment, remote D1 migration, production secret change, or Gmail OAuth setup has been performed.

## Local validation

From `workers/sales-command-center`:

```sh
npm test
npx tsc src/index.ts --target ES2022 --module commonjs --lib ES2022,DOM --skipLibCheck --noEmit
```

The Node test suite creates a temporary SQLite database, applies the current schema and migrations, then exercises CRM auth/scopes, idempotency, audit records, contact and company linking, task operations, provider separation, and existing dashboard API access. It does not connect to Cloudflare or Gmail.

## Before any production rollout

1. Export or create a restorable backup of the production D1 database and record the current Worker version.
2. Apply migration `0005_crm_integration_foundation.sql` to a non-production/preview D1 database first.
3. Verify the existing `sales_records` counts and representative clients/leads before and after migration; confirm new company/contact mappings and existing dashboard routes.
4. Deploy the Worker only after preview validation, then run read-only smoke checks before issuing any integration key.
5. Keep Gmail OAuth out of this phase. Confirm Google Workspace mailbox status and obtain written confirmation of OAuth verification and restricted-scope assessment requirements before Phase 2.

## Rollback

The safest rollback is to redeploy the previous Worker version and leave the additive D1 tables in place. Existing `/v1/sales/*` behavior and `sales_records` are preserved, and the previous Worker ignores the new tables. This retains any new CRM integration data if the new API has already been used.

Do not drop the new tables as part of a routine rollback: doing so would permanently remove contacts/aliases, notes, communications, tasks, credentials metadata, audit entries, and idempotency/rate-limit state. If a full schema rollback is ever required before any new data has been written, first take a backup and review dependencies; execute a separately reviewed cleanup migration only after confirming no data needs to be retained. No destructive rollback SQL is included intentionally.

## Deployment boundary

This task stops before all production actions. Phase 2 (Gmail OAuth/synchronization and automatic follow-up generation) must not start until its OAuth cost/compliance review and the Phase 1 production rollout are separately completed.
