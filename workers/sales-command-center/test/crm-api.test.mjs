import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

const here = resolve(new URL('.', import.meta.url).pathname, '..');
let compiledDir, worker;

before(() => {
  compiledDir = mkdtempSync(join(tmpdir(), '10k-crm-worker-'));
  execFileSync(join(here, 'node_modules/.bin/tsc'), [
    'src/index.ts', '--target', 'ES2022', '--module', 'commonjs', '--lib', 'ES2022,DOM', '--skipLibCheck', '--outDir', compiledDir,
  ], { cwd: here, stdio: 'pipe' });
  worker = createRequire(import.meta.url)(join(compiledDir, 'index.js')).default;
});

after(() => { if (compiledDir) rmSync(compiledDir, { recursive: true, force: true }); });

class LocalD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const wrapper = {
      args: [],
      bind(...args) { this.args = args; return this; },
      all() { return { results: db.prepare(sql).all(...this.args) }; },
      run() { return db.prepare(sql).run(...this.args); },
    };
    return wrapper;
  }
}

const sha256 = async (value) => Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(value))).toString('hex');
let db, env, companyOne, companyTwo, leadId;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  for (const file of ['0002_partnerships_features.sql', '0003_sales_foundation.sql', '0004_simplify_sales_stages.sql']) {
    db.exec(readFileSync(join(here, 'migrations', file), 'utf8'));
  }
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO sales_records (id,entity_type,name,stage,industry,status,monthly_revenue,total_value,probability,next_follow_up,contract_end,last_contact,data_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('company-one', 'prospect', 'Northland Ford', '', 'Automotive', 'open', 0, 0, 0, null, null, null,
    JSON.stringify({ primary_contact: 'Jorgen Karlsrud', contact_email: 'Jorgen.Karlsrud@example.com', additional_contacts: [{ name: 'Alex Marketing', email: 'alex@example.com' }] }), now, now);
  insert.run('company-two', 'client', 'Test Client', '', 'Sports', 'active', 100, 1200, 0, null, null, null,
    JSON.stringify({ primary_contact: 'Jorgen Karlsrud', contact_email: 'jorgen.karlsrud@example.com' }), now, now);
  insert.run('lead-one', 'lead', 'Northland Ford', 'Contacted', 'Automotive', 'open', 0, 5000, 20, null, null, now,
    JSON.stringify({ company_name: 'Northland Ford', stage: 'Contacted', estimated_total_value: 5000 }), now, now);
  db.exec(readFileSync(join(here, 'migrations', '0005_crm_integration_foundation.sql'), 'utf8'));
  db.exec(readFileSync(join(here, 'migrations', '0006_gmail_internal_metadata_sync.sql'), 'utf8'));
  env = { DB: new LocalD1(db), SALES_JACK_TOKEN: 'jack-test-token-with-at-least-thirty-two-characters', SALES_CODY_TOKEN: 'cody-test-token-with-at-least-thirty-two-characters', PUBLIC_READ_ORIGIN: 'https://10000takes.github.io' };
  companyOne = db.prepare("SELECT company_id FROM sales_record_companies WHERE record_id='company-one'").get().company_id;
  companyTwo = db.prepare("SELECT company_id FROM sales_record_companies WHERE record_id='company-two'").get().company_id;
  leadId = 'lead-one';
});

afterEach(() => db?.close());

async function call(path, { method = 'GET', token = env.SALES_JACK_TOKEN, body, key, origin } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (origin) headers.Origin = origin;
  const response = await worker.fetch(new Request(`https://worker.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { response, data: await response.json() };
}

async function addApiKey({ label, scopes, rate = 60, createdBy = 'jack', token = 'integration-token-with-at-least-thirty-two-characters' }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sales_crm_api_credentials (id,label,token_sha256,scopes_json,rate_limit_per_minute,created_by,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(id, label, await sha256(token), JSON.stringify(scopes), rate, createdBy, new Date().toISOString());
  return token;
}

test('migration backfills existing contacts, aliases and company links without changing the CRM records', () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_records").get().n, 3);
  const canonical = db.prepare("SELECT company_id FROM sales_record_companies WHERE record_id='company-one'").get().company_id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_company_contacts WHERE company_id=?').get(canonical).n, 2);
  // The same legacy person can be associated with multiple brands; retain both links.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_company_contacts WHERE contact_id='legacy:email:jorgen.karlsrud@example.com'").get().n, 2);
  db.exec(readFileSync(join(here, 'migrations', '0005_crm_integration_foundation.sql'), 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_contacts').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_contact_emails').get().n, 2);
});

test('CRM API rejects missing auth and enforces per-key scopes', async () => {
  const unauthenticated = await call('/v1/crm/companies', { token: '' });
  assert.equal(unauthenticated.response.status, 401);
  const contactsOnly = await addApiKey({ label: 'contacts only', scopes: ['contacts:read'] });
  const allowed = await call('/v1/crm/contacts?q=jorgen', { token: contactsOnly });
  assert.equal(allowed.response.status, 200);
  assert.ok(allowed.data.contacts.length >= 1);
  const denied = await call('/v1/crm/companies', { token: contactsOnly });
  assert.equal(denied.response.status, 403);
});

test('contact writes are idempotent and allow separate people at one company', async () => {
  const body = { display_name: 'Taylor Smith', email: 'Taylor@Brand.example', company_ids: [companyOne], title: 'Marketing Manager' };
  const first = await call('/v1/crm/contacts', { method: 'POST', body, key: 'contact-create-0001' });
  const replay = await call('/v1/crm/contacts', { method: 'POST', body, key: 'contact-create-0001' });
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.response.headers.get('Idempotent-Replay'), 'true');
  assert.equal(replay.data.id, first.data.id);
  const second = await call('/v1/crm/contacts', { method: 'POST', body: { display_name: 'Morgan Lee', email: 'morgan@brand.example', company_ids: [companyOne] }, key: 'contact-create-0002' });
  assert.equal(second.response.status, 201);
  assert.notEqual(second.data.id, first.data.id);
  const query = await call(`/v1/crm/contacts?company_id=${companyOne}`);
  assert.ok(query.data.contacts.some((contact) => contact.id === first.data.id));
  assert.ok(query.data.contacts.some((contact) => contact.id === second.data.id));
  const duplicateAlias = await call('/v1/crm/contacts', { method: 'POST', body: { display_name: 'Taylor Smith', email: 'taylor@brand.example', company_ids: [companyTwo] }, key: 'contact-link-0003' });
  assert.equal(duplicateAlias.data.id, first.data.id);
  assert.equal(duplicateAlias.data.matched_existing, true);
});

test('canonical companies can be created and updated without replacing sales_records opportunities', async () => {
  const created = await call('/v1/crm/companies', { method: 'POST', key: 'company-create-0001', body: { name: 'New Brand', industry: 'Retail' } });
  assert.equal(created.response.status, 201);
  const replay = await call('/v1/crm/companies', { method: 'POST', key: 'company-create-0001', body: { name: 'New Brand', industry: 'Retail' } });
  assert.equal(replay.response.headers.get('Idempotent-Replay'), 'true');
  const updated = await call(`/v1/crm/companies/${created.data.id}`, { method: 'PATCH', key: 'company-update-0001', body: { website: 'https://brand.example' } });
  assert.equal(updated.response.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_records WHERE entity_type='lead'").get().n, 1);
});

test('integration writes are audited, research sources validated, and opportunity rows remain sales_records leads', async () => {
  const note = await call('/v1/crm/research-notes', { method: 'POST', key: 'research-note-0001', body: { company_id: companyOne, note: 'Confirmed regional campaign interest.', source_url: 'https://example.com/news', confidence: 'medium' } });
  assert.equal(note.response.status, 201);
  const invalid = await call('/v1/crm/research-notes', { method: 'POST', key: 'research-note-0002', body: { company_id: companyOne, note: 'bad url', source_url: 'http://example.com' } });
  assert.equal(invalid.response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_company_research_notes').get().n, 1);
  const update = await call(`/v1/crm/opportunities/${leadId}`, { method: 'PATCH', key: 'opp-update-0001', body: { stage: 'Proposal Sent', total_value: 15000, probability: 35 } });
  assert.equal(update.response.status, 200);
  assert.equal(db.prepare("SELECT stage FROM sales_records WHERE id='lead-one'").get().stage, 'Proposal Sent');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_audit_log WHERE action IN ('crm_research_note_added','crm_opportunity_updated')").get().n, 2);
});

test('task creation is idempotent and per-key request limits are enforced', async () => {
  const taskBody = { company_id: companyOne, record_id: leadId, title: 'Follow up on sponsorship', due_at: '2026-11-25', dedupe_key: 'gmail-thread-abc:followup' };
  const first = await call('/v1/crm/follow-up-tasks', { method: 'POST', key: 'task-create-0001', body: taskBody });
  const replay = await call('/v1/crm/follow-up-tasks', { method: 'POST', key: 'task-create-0001', body: taskBody });
  assert.equal(first.response.status, 201);
  assert.equal(replay.response.headers.get('Idempotent-Replay'), 'true');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_follow_up_tasks').get().n, 1);
  const limitedToken = await addApiKey({ label: 'one call', scopes: ['companies:read'], rate: 1, token: 'rate-limit-token-with-at-least-thirty-two-characters' });
  assert.equal((await call('/v1/crm/companies', { token: limitedToken })).response.status, 200);
  assert.equal((await call('/v1/crm/companies', { token: limitedToken })).response.status, 429);
});

test('Gmail message keys and Resend records remain separate to avoid duplicate activities', async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sales_communications (id,provider,gmail_message_id,gmail_thread_id,company_id,record_id,direction,from_email,subject,snippet,occurred_at,synced_at)
    VALUES ('gmail-1','gmail','message-1','thread-1',?,?,'sent','partnerships@10ktakesmn.com','Pitch','Gmail message preview',?,?)`).run(companyOne, leadId, now, now);
  db.prepare(`INSERT OR IGNORE INTO sales_communications (id,provider,gmail_message_id,gmail_thread_id,company_id,record_id,direction,from_email,subject,snippet,occurred_at,synced_at)
    VALUES ('gmail-duplicate','gmail','message-1','thread-1',?,?,'sent','partnerships@10ktakesmn.com','Pitch','Duplicate attempt',?,?)`).run(companyOne, leadId, now, now);
  db.prepare("INSERT INTO outreach_log (id,lead_id,recipient,subject,body,provider_id,sent_at) VALUES ('resend-1',?,'prospect@example.com','Pitch','Resend copy','resend-message-1',?)").run(leadId, now);
  db.prepare("INSERT INTO sales_activities (id,record_id,activity_type,summary,occurred_at,created_at) VALUES ('resend-activity-1',?,'email_sent','Sent via Resend',?,?)").run(leadId, now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE provider='gmail' AND gmail_message_id='message-1'").get().n, 1);
  const history = await call(`/v1/crm/communications?company_id=${companyOne}`);
  assert.equal(history.data.communications.length, 2);
  assert.deepEqual(new Set(history.data.communications.map((message) => message.provider)), new Set(['gmail', 'resend']));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_activities WHERE activity_type='email_sent'").get().n, 1);
});

test('existing dashboard Sales API remains available with its existing named token and origin check', async () => {
  const ok = await call('/v1/sales/records?type=lead', { origin: 'https://10000takes.github.io' });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.data.records.length, 1);
  const denied = await call('/v1/sales/records?type=lead', { origin: 'https://attacker.example' });
  assert.equal(denied.response.status, 403);
});
