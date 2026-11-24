# 10K Hub Production Launch Runbook

**Status:** Preparation only. No production migration, Worker deployment, API key, OAuth secret, import, or Gmail connection has been created or changed.

## Stop conditions

Stop immediately if a production schema, migration-ledger entry, CRM count, Worker version, or configuration differs from the audited state. Do not repair a mismatch during the rollout window; capture it and re-audit first. Stop if any command reports an unexpected migration, any backup verification fails, or the OAuth environment is not clearly `production`.

## 1. Pin and validate the release

The application release is commit `6cdc427` on `codex/prod-release-candidate`, based on `b0da3a4439803c81ad369d92c6acb2689f98ea29`. It contains only `src/index.ts`, `src/mcp.ts`, and `test/crm-api.test.mjs`. The staging-only `wrangler.jsonc` change is not in that commit.

From `workers/sales-command-center`:

```sh
npm test
python3 -m unittest discover -s scripts -p 'test*.py' -v
npx wrangler deploy --dry-run --env=""
```

The production dry run is valid only after the real production `OAUTH_KV` binding and production MCP variables are present. Do not treat a dry run that omits those bindings as deployment approval.

## 2. Create an encrypted local backup destination

The encryption state of `/Volumes/Jack's Passport` could not be verified. Do not store an export there in plaintext. In Disk Utility, choose **File → New Image → Blank Image**. Save it on the private Mac or external volume; name it `10K Hub Production Backup`; select **APFS**, **AES-256 encryption**, **read/write** or **sparse bundle**, and a suitable maximum size. Use a unique password saved in the password manager, not in the repository or shell history. Keep the image mounted only while using it and eject it when finished. Apple documents these options in [Create a secure disk image](https://support.apple.com/en-euro/guide/disk-utility/dskutl11888/mac).

After mounting it as `/Volumes/10K Hub Production Backup`, use that mounted encrypted volume for both SQL files and the restore-check database. Never place either in the repository, GitHub Pages, an unencrypted shared folder, or a ticket/chat. Set private file permissions in the terminal session:

```sh
umask 077
```

## 3. Recheck production before the first change

```sh
cd /Users/jackleverentz/Documents/GitHub/10k-takes-data/workers/sales-command-center
npx wrangler d1 migrations list 10k-takes-sales-command-center --remote
npx wrangler d1 execute 10k-takes-sales-command-center --remote --command "SELECT entity_type,COUNT(*) AS n FROM sales_records GROUP BY entity_type ORDER BY entity_type; SELECT COUNT(*) AS n FROM sales_activities; SELECT COUNT(*) AS n FROM outreach_log; SELECT id,stage,json_extract(data_json,'$.stage') AS json_stage FROM sales_records WHERE entity_type='lead'; SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sales_companies','sales_contacts','sales_communications','sales_follow_up_tasks','sales_gmail_oauth_credentials','sales_gmail_sync_queue') ORDER BY name; SELECT name FROM d1_migrations ORDER BY name;"
```

Expected: 27 clients, one lead, 28 total sales records; 28 activities; no existing outreach log rows; the lead stage is `Contacted` in both locations; no 0005/0006 tables; and no migration-ledger rows. If any result differs, stop and reconcile against the new live state.

## 4. Capture the recovery point and encrypted export

Do this immediately before the first production write (including the migration-ledger correction):

```sh
npx wrangler d1 time-travel info 10k-takes-sales-command-center
npx wrangler d1 export 10k-takes-sales-command-center --remote --output="/Volumes/10K Hub Production Backup/10k-hub-production-prelaunch.sql"
npx wrangler d1 export 10k-takes-sales-command-center --remote --table sales_records --table sales_activities --table outreach_log --table revenue_entries --table deliverable_definitions --table deliverable_monthly --table sales_users --table sales_discovery_sources --table sales_agent_settings --table sales_research_sources --table sales_record_relationships --table sales_audit_log --table sales_suppressions --table outreach_send_guards --table sales_agent_runs --output="/Volumes/10K Hub Production Backup/legacy-tables-before.sql"
test -s "/Volumes/10K Hub Production Backup/10k-hub-production-prelaunch.sql"
shasum -a 256 "/Volumes/10K Hub Production Backup/10k-hub-production-prelaunch.sql" > "/Volumes/10K Hub Production Backup/10k-hub-production-prelaunch.sha256"
```

Record the fresh Time Travel bookmark in a text file inside the mounted encrypted volume. Verify the export is usable there, not in `/tmp` or the repository:

```sh
sqlite3 "/Volumes/10K Hub Production Backup/restore-check.db" < "/Volumes/10K Hub Production Backup/10k-hub-production-prelaunch.sql"
sqlite3 "/Volumes/10K Hub Production Backup/restore-check.db" "PRAGMA integrity_check; SELECT entity_type,COUNT(*) FROM sales_records GROUP BY entity_type ORDER BY entity_type;"
```

Expected integrity result: `ok`; counts must be 27 clients and one lead. Preserve the export, checksum, and bookmark in the encrypted volume; eject it after use.

## 5. Reconcile the ledger without replaying 0002–0004

Only after Step 3 matches and Step 4 passes, insert the exact migration filenames as already satisfied. This changes the ledger only; it does not execute their SQL:

```sh
npx wrangler d1 execute 10k-takes-sales-command-center --remote --command "INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0002_partnerships_features.sql'), ('0003_sales_foundation.sql'), ('0004_simplify_sales_stages.sql');"
npx wrangler d1 migrations list 10k-takes-sales-command-center --remote
```

Stop unless the list shows **only** `0005_crm_integration_foundation.sql` and `0006_gmail_internal_metadata_sync.sql` pending. This ledger repair is the first production write and requires explicit approval.

## 6. Apply the verified missing migrations

```sh
npx wrangler d1 migrations apply 10k-takes-sales-command-center --remote
npx wrangler d1 migrations list 10k-takes-sales-command-center --remote
```

Stop unless both 0005 and 0006 are recorded as applied and none remain pending. Do not rerun 0006; it contains non-idempotent `ALTER TABLE ... ADD COLUMN` operations. Wrangler captures a migration backup during apply; retain its output as well as the pre-change Time Travel bookmark and export. See [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/).

## 7. Configure production MCP separately

The production Worker is the root Wrangler environment. It must have these non-secret variables and bindings before deployment:

```jsonc
"vars": {
  "PUBLIC_READ_ORIGIN": "https://10000takes.github.io",
  "MCP_ENVIRONMENT": "production",
  "MCP_SERVICE_NAME": "10K Hub CRM — Production",
  "MCP_SERVER_URL": "https://10k-takes-sales-command-center.10ktakes.workers.dev/mcp",
  "MCP_OAUTH_ISSUER": "https://10k-takes-sales-command-center.10ktakes.workers.dev",
  "MCP_CRM_API_BASE_URL": "https://10k-takes-sales-command-center.10ktakes.workers.dev"
},
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<new-production-only-namespace-id>" }],
"version_metadata": { "binding": "CF_VERSION_METADATA" }
```

The namespace ID must be for a new production-only KV namespace, never the staging namespace `22445adea8f2460fa8a14a04fee6f9b5`. Creating the namespace and changing Worker secrets are Cloudflare production resource changes; obtain explicit approval before doing either. After approval, the namespace command is:

```sh
npx wrangler kv namespace create 10k-hub-crm-production-oauth --binding OAUTH_KV --use-remote --update-config
```

Add the returned ID to the root binding above. Set separate secrets through interactive prompts (do not put values in commands, files, or logs):

```sh
npx wrangler secret put MCP_AUTH_PASSWORD --name 10k-takes-sales-command-center
npx wrangler secret put MCP_CRM_API_TOKEN --name 10k-takes-sales-command-center
```

Use a new production passphrase and a high-entropy production API token. Store the token hash in `sales_crm_api_credentials`; scopes should cover only company/contact/prospect search and writes, research read/write, communication read, opportunity read/write, and task read/write. Do not grant email send, delete, or Gmail credential scopes. Keep the raw token only as the Worker secret and in a password manager for setup; never commit it. The OAuth consent scopes remain `crm:read`, `crm:write`, and `offline_access` only.

After migration 0005 creates `sales_crm_api_credentials`, generate a 64-character random token in a password manager (or another approved secure generator). To derive its D1 hash without echoing the token, run this locally and enter it only at the hidden prompt:

```sh
python3 -c 'import getpass,hashlib; print(hashlib.sha256(getpass.getpass("Production MCP API token: ").encode()).hexdigest())'
```

Insert only that SHA-256 result into D1, with the least privileges needed by the existing MCP tools, then paste the raw value into the interactive Worker-secret prompt. Both the D1 row and secret update require explicit production-change approval:

```sh
npx wrangler d1 execute 10k-takes-sales-command-center --remote --command "INSERT INTO sales_crm_api_credentials (id,label,token_sha256,scopes_json,rate_limit_per_minute,created_by,created_at,expires_at) VALUES (lower(hex(randomblob(16))),'ChatGPT Business — Production','<SHA256_OF_TOKEN>','[\"companies:read\",\"companies:write\",\"contacts:read\",\"contacts:write\",\"prospects:read\",\"prospects:write\",\"communications:read\",\"research:read\",\"research:write\",\"opportunities:read\",\"opportunities:write\",\"tasks:read\",\"tasks:write\"]',60,'jack',datetime('now'),datetime('now','+90 days'));"
npx wrangler secret put MCP_CRM_API_TOKEN --name 10k-takes-sales-command-center
```

Use a separate, randomly generated passphrase for `MCP_AUTH_PASSWORD`; do not reuse the API token. Revoke the credential row and replace the Worker secret together during rotation.

The MCP tool allowlist contains no outbound-email, record-delete, or Gmail-credential management tools. The staging warning about the root `_10k_takes_sales_command_center` D1 binding is non-fatal: Wrangler does not inherit root D1 bindings into staging, staging explicitly binds `DB` to D1 `0b960090-30e9-43ed-bd15-1ad7dfe05f81`, and application code uses `DB` only. The root alias points to production but is not present in staging and is not referenced by source. No staging-to-production D1 path was found.

## 8. Validate config, then deploy the Worker

```sh
npx wrangler deploy --dry-run --env=""
npx wrangler deploy --env=""
```

The dry run must show production `DB`, production `OAUTH_KV`, production MCP variables, and version metadata. Stop if it shows the staging D1 or KV IDs, missing bindings, or a non-production environment label. The deploy command is a production change and requires explicit approval.

## 9. Verify data and existing behavior

Repeat the record-count query from Step 3. Export the same legacy tables to `legacy-tables-after.sql` with the same `wrangler d1 export --table ...` command, then compare `shasum -a 256` for the before/after legacy dumps; they should match. Expected unchanged counts include 27 clients, one lead, and 28 activities. Verify canonical company links (28), backfilled contacts (five), and no Gmail OAuth credentials or sync queue rows. Check the production dashboard, Sales API, prospect-to-lead promotion, client views, and Resend workflow; do not send an email as a test.

## 10. Connect ChatGPT and run read-only smoke tests

In the Partnerships Project, add the production MCP server URL above and authenticate using the production passphrase. Confirm `get_crm_environment` reports `production`, service `10K Hub CRM — Production`, and only the authorized `crm:read`/`crm:write` permissions. Then run a read-only company search, contact search, and communication-history read. Do not create or update records in this phase.

## 11. Separate write approval

After the read-only smoke test passes, stop. Request separate explicit approval for a synthetic production write test. The test should cover idempotency, audit logging, and safe promotion, then confirm the 28 existing `sales_records` rows are unchanged except for the approved synthetic addition. No historical import is part of this launch.

## Rollback

- **Worker rollback:** use for bad routing, auth, MCP, or dashboard/API behavior when database integrity and data are intact. Recheck the current pre-release Worker version before using `npx wrangler rollback <VERSION_ID> --name 10k-takes-sales-command-center --env=""`. The old Worker will not serve the new CRM endpoints; the additive tables remain intact.
- **Database restore:** use only if verification shows corruption or unintended data mutation that cannot be corrected safely with forward repair. First preserve the post-change state, then restore the fresh pre-change bookmark with `npx wrangler d1 time-travel restore 10k-takes-sales-command-center --bookmark=<FRESH_PRECHANGE_BOOKMARK>`. This overwrites the database and can erase legitimate writes made since the bookmark. Cloudflare documents the destructive restore and recovery bookmark behavior in [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Keep Gmail disconnected throughout this runbook. With no connected mailbox credential row, the scheduled Gmail job must report `skipped_not_connected`; do not configure Google OAuth secrets or authorize the mailbox here.
