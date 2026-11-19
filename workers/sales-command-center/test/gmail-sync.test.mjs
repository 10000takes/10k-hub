import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const here = resolve(new URL('.', import.meta.url).pathname, '..');
let compiledDir, worker, db, env, originalFetch;

before(() => {
  compiledDir = mkdtempSync(join(tmpdir(), '10k-gmail-worker-'));
  execFileSync(join(here, 'node_modules/.bin/tsc'), [
    'src/index.ts', '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM', '--skipLibCheck', '--outDir', compiledDir,
  ], { cwd: here, stdio: 'pipe' });
  worker = createRequire(import.meta.url)(join(compiledDir, 'index.js')).default;
});
after(() => { if (compiledDir) rmSync(compiledDir, { recursive: true, force: true }); });

class LocalD1 {
  constructor(database) { this.database = database; }
  prepare(sql) {
    const database = this.database;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      all() { return { results: database.prepare(sql).all(...this.args) }; },
      run() { return database.prepare(sql).run(...this.args); },
    };
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  for (const migration of ['0002_partnerships_features.sql', '0003_sales_foundation.sql', '0004_simplify_sales_stages.sql']) {
    db.exec(readFileSync(join(here, 'migrations', migration), 'utf8'));
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sales_records (id,entity_type,name,stage,industry,status,monthly_revenue,total_value,probability,next_follow_up,contract_end,last_contact,data_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('lead', 'lead', 'Northland Ford', 'Contacted', 'Automotive', 'open', 0, 5000, 20, null, null, null,
      JSON.stringify({ primary_contact: 'Jorgen Karlsrud', contact_email: 'jorgen.karlsrud@example.com' }), now, now);
  for (const migration of ['0005_crm_integration_foundation.sql', '0006_gmail_internal_metadata_sync.sql']) {
    db.exec(readFileSync(join(here, 'migrations', migration), 'utf8'));
  }
  env = {
    DB: new LocalD1(db),
    SALES_JACK_TOKEN: 'jack-test-token-with-at-least-thirty-two-characters',
    SALES_CODY_TOKEN: 'cody-test-token-with-at-least-thirty-two-characters',
    PUBLIC_READ_ORIGIN: 'https://10000takes.github.io',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://worker.test/v1/sales/gmail/callback',
    GMAIL_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
  };
});
afterEach(() => { globalThis.fetch = originalFetch; db?.close(); });

async function request(path, { method = 'GET', token = env.SALES_JACK_TOKEN, origin = 'https://10000takes.github.io' } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Origin: origin };
  return worker.fetch(new Request(`https://worker.test${path}`, { method, headers }), env);
}

async function connectMailbox() {
  const connectResponse = await request('/v1/sales/gmail/connect', { method: 'POST' });
  assert.equal(connectResponse.status, 200);
  const connect = await connectResponse.json();
  const authorization = new URL(connect.authorization_url);
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.metadata');
  assert.equal(authorization.searchParams.get('access_type'), 'offline');
  const state = authorization.searchParams.get('state');
  assert.ok(state && state.length >= 32);
  const stateRow = db.prepare('SELECT state_sha256,pkce_verifier_ciphertext FROM sales_gmail_oauth_states').get();
  assert.notEqual(stateRow.state_sha256, state);
  assert.notEqual(stateRow.pkce_verifier_ciphertext, authorization.searchParams.get('code_challenge'));
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'temporary-access-token', refresh_token: 'stored-refresh-token' });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return Response.json({ emailAddress: 'partnerships@10ktakesmn.com', historyId: '100' });
    throw new Error(`Unexpected network request in test: ${url}`);
  };
  const callback = await worker.fetch(new Request(`https://worker.test/v1/sales/gmail/callback?code=one-time-code&state=${encodeURIComponent(state)}`), env);
  assert.equal(callback.status, 200);
  assert.equal(db.prepare('SELECT status FROM sales_gmail_oauth_credentials').get().status, 'connected');
  return state;
}

test('Gmail connection uses metadata-only OAuth and verifies the exact mailbox', async () => {
  const forbidden = await request('/v1/sales/gmail/connect', { method: 'POST', token: env.SALES_CODY_TOKEN });
  assert.equal(forbidden.status, 403);
  const state = await connectMailbox();
  const credential = db.prepare('SELECT refresh_token_ciphertext,scopes_json FROM sales_gmail_oauth_credentials').get();
  assert.notEqual(credential.refresh_token_ciphertext, 'stored-refresh-token');
  assert.equal(credential.scopes_json, JSON.stringify(['https://www.googleapis.com/auth/gmail.metadata']));
  const status = await request('/v1/sales/gmail/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).mailbox.email, 'partnerships@10ktakesmn.com');
  const replay = await worker.fetch(new Request(`https://worker.test/v1/sales/gmail/callback?code=one-time-code&state=${encodeURIComponent(state)}`), env);
  assert.equal(replay.status, 400, 'OAuth state is single use');
});

test('sync stores header metadata only, records drafts, deduplicates messages and cancels follow-up on reply', async () => {
  await connectMailbox();
  db.prepare(`UPDATE sales_companies SET website='https://northlandford.com' WHERE id=(SELECT company_id FROM sales_record_companies WHERE record_id='lead')`).run();
  assert.equal(db.prepare("SELECT website FROM sales_companies WHERE id=(SELECT company_id FROM sales_record_companies WHERE record_id='lead')").get().website, 'https://northlandford.com');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_companies WHERE website<>'' AND lower(website) LIKE '%northlandford.com%'").get().n, 1);
  const contactId = 'legacy:email:jorgen.karlsrud@example.com';
  const outgoing = {
    id: 'sent-1', threadId: 'thread-1', labelIds: ['SENT'], internalDate: String(Date.parse('2026-11-19T16:00:00Z')),
    payload: { headers: [
      { name: 'From', value: 'partnerships@10ktakesmn.com' }, { name: 'To', value: 'Jorgen Karlsrud <jorgen.karlsrud@example.com>' },
      { name: 'Subject', value: 'Partnership idea' }, { name: 'Date', value: 'Thu, 19 Nov 2026 10:00:00 -0600' },
    ] },
  };
  const draft = {
    id: 'draft-1', threadId: 'thread-draft', labelIds: ['DRAFT'], internalDate: String(Date.parse('2026-11-19T16:10:00Z')),
    payload: { headers: [
      { name: 'From', value: 'partnerships@10ktakesmn.com' }, { name: 'To', value: 'Jorgen <jorgen.karlsrud@example.com>' },
      { name: 'Subject', value: 'Unsent draft' },
    ] },
  };
  const unrelated = {
    id: 'unrelated-1', threadId: 'unrelated-thread', labelIds: ['INBOX'], internalDate: String(Date.parse('2026-11-19T16:20:00Z')),
    payload: { headers: [{ name: 'From', value: 'Someone <someone@example.org>' }, { name: 'To', value: 'partnerships@10ktakesmn.com' }, { name: 'Subject', value: 'Unrelated private email' }] },
  };
  const unknownContactKnownCompany = {
    id: 'company-domain-1', threadId: 'company-domain-thread', labelIds: ['INBOX'], internalDate: String(Date.parse('2026-11-19T16:30:00Z')),
    payload: { headers: [{ name: 'From', value: 'New Person <new.person@northlandford.com>' }, { name: 'To', value: 'partnerships@10ktakesmn.com' }, { name: 'Subject', value: 'Known company, new contact' }] },
  };
  let historyPoll = 0, metadataGetCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'temporary-access-token' });
    if (url.pathname.endsWith('/messages')) {
      assert.equal(url.searchParams.has('q'), false, 'metadata scope must not use Gmail search queries');
      return Response.json({ messages: [{ id: 'sent-1' }, { id: 'draft-1' }, { id: 'unrelated-1' }, { id: 'company-domain-1' }] });
    }
    if (url.pathname.endsWith('/messages/sent-1') || url.pathname.endsWith('/messages/draft-1')) {
      assert.equal(url.searchParams.get('format'), 'metadata');
      assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References']);
      metadataGetCount++;
      return Response.json(url.pathname.endsWith('/sent-1') ? outgoing : draft);
    }
    if (url.pathname.endsWith('/messages/unrelated-1')) {
      assert.equal(url.searchParams.get('format'), 'metadata');
      return Response.json(unrelated);
    }
    if (url.pathname.endsWith('/messages/company-domain-1')) {
      assert.equal(url.searchParams.get('format'), 'metadata');
      return Response.json(unknownContactKnownCompany);
    }
    if (url.pathname.endsWith('/history')) {
      historyPoll++;
      if (historyPoll === 1) return Response.json({ historyId: '101', history: [{ messagesAdded: [{ message: { id: 'sent-1', threadId: 'thread-1' } }, { message: { id: 'reply-1', threadId: 'thread-1' } }] }] });
      return Response.json({ historyId: '101', history: [] });
    }
    if (url.pathname.endsWith('/messages/reply-1')) {
      assert.equal(url.searchParams.get('format'), 'metadata');
      return Response.json({
        id: 'reply-1', threadId: 'thread-1', labelIds: ['INBOX'], internalDate: String(Date.parse('2026-11-20T16:00:00Z')),
        payload: { headers: [{ name: 'From', value: 'Jorgen Karlsrud <jorgen.karlsrud@example.com>' }, { name: 'To', value: 'partnerships@10ktakesmn.com' }, { name: 'Subject', value: 'Re: Partnership idea' }] },
      });
    }
    throw new Error(`Unexpected network request in test: ${init.method ?? 'GET'} ${url}`);
  };

  const first = await request('/v1/sales/gmail/sync', { method: 'POST' });
  assert.equal(first.status, 200, await first.clone().text());
  const syncCounts = await first.clone().json();
  assert.equal(syncCounts.unmatched, 1, JSON.stringify(syncCounts));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE provider='gmail'").get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE gmail_message_id='unrelated-1'").get().n, 0, 'unmatched messages are discarded');
  const domainMatched = db.prepare("SELECT company_id,contact_id FROM sales_communications WHERE gmail_message_id='company-domain-1'").get();
  assert.ok(domainMatched.company_id, 'unknown contact is retained at company level when the sender domain matches a known company website');
  assert.equal(domainMatched.contact_id, null, 'sync does not invent a contact');
  assert.equal(db.prepare("SELECT direction FROM sales_communications WHERE gmail_message_id='sent-1'").get().direction, 'sent');
  assert.equal(db.prepare("SELECT direction FROM sales_communications WHERE gmail_message_id='draft-1'").get().direction, 'draft');
  assert.equal(db.prepare("SELECT body_ciphertext,snippet FROM sales_communications WHERE gmail_message_id='sent-1'").get().body_ciphertext, '');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_follow_up_tasks WHERE status='open'").get().n, 1);
  const task = db.prepare("SELECT due_at,contact_id FROM sales_follow_up_tasks WHERE status='open'").get();
  assert.equal(task.due_at, '2026-11-25');
  assert.equal(task.contact_id, contactId);

  const second = await request('/v1/sales/gmail/sync', { method: 'POST' });
  assert.equal(second.status, 200, await second.clone().text());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE provider='gmail'").get().n, 4);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_follow_up_tasks WHERE status='open'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_follow_up_tasks WHERE status='cancelled'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE gmail_message_id='reply-1' AND contact_id=?").get(contactId).n, 1);
  assert.equal(metadataGetCount, 3);
  const timelineResponse = await request('/v1/sales/gmail/communications?record_id=lead');
  const timeline = await timelineResponse.json();
  assert.equal(timelineResponse.status, 200);
  assert.ok(timeline.last_contacted_at);
  assert.ok(timeline.last_reply_at);
  assert.equal(timeline.next_follow_up_at, null);
});

test('Gmail OAuth callback refuses a different mailbox', async () => {
  const connect = await request('/v1/sales/gmail/connect', { method: 'POST' });
  const state = new URL((await connect.json()).authorization_url).searchParams.get('state');
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'temporary-access-token', refresh_token: 'temporary-refresh-token' });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return Response.json({ emailAddress: 'someone-else@gmail.com', historyId: '100' });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  };
  const response = await worker.fetch(new Request(`https://worker.test/v1/sales/gmail/callback?code=one-time-code&state=${encodeURIComponent(state)}`), env);
  assert.equal(response.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_gmail_oauth_credentials').get().n, 0);
});

test('scheduled sync records failures and retries them on the next schedule while credentials remain valid', async () => {
  await connectMailbox();
  let attempts = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'temporary-access-token' });
    if (url.pathname.endsWith('/messages')) { attempts++; return Response.json({ error: 'temporary failure' }, { status: 503 }); }
    throw new Error(`Unexpected request: ${url}`);
  };
  const runCron = async () => {
    let task;
    await worker.scheduled({}, env, { waitUntil(promise) { task = promise; } });
    await task;
  };
  await runCron();
  assert.equal(db.prepare("SELECT status FROM sales_gmail_sync_state WHERE mailbox_email='partnerships@10ktakesmn.com'").get().status, 'error');
  await runCron();
  assert.equal(attempts, 2, 'the next scheduled run retries a transient failure');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_audit_log WHERE action='gmail_sync_scheduled_failed'").get().n, 2);
});
