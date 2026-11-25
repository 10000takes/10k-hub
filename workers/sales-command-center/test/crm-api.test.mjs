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

test('company search treats business-name punctuation and LIKE metacharacters literally', async () => {
  const exactName = "O'Reilly & Sons — 50% Off_Season (Twin Cities) - North";
  const wildcardLookalike = "O'Reilly & Sons — 50X OffXSeason (Twin Cities) - North";
  const first = await call('/v1/crm/companies', { method: 'POST', key: 'company-search-special-001', body: { name: exactName, industry: 'Synthetic QA' } });
  const second = await call('/v1/crm/companies', { method: 'POST', key: 'company-search-special-002', body: { name: wildcardLookalike, industry: 'Synthetic QA' } });
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);

  const full = await call(`/v1/crm/companies?q=${encodeURIComponent(exactName)}`);
  assert.deepEqual(full.data.companies.map((company) => company.id), [first.data.id]);
  for (const query of ["O'Reilly", '50%', 'Off_Season', '50% Off_Season', ' - North']) {
    const result = await call(`/v1/crm/companies?q=${encodeURIComponent(query)}`);
    assert.ok(result.data.companies.some((company) => company.id === first.data.id), `expected match for ${query}`);
  }
  const literalPercent = await call(`/v1/crm/companies?q=${encodeURIComponent('50%')}`);
  assert.deepEqual(literalPercent.data.companies.map((company) => company.id), [first.data.id]);
  const literalUnderscore = await call(`/v1/crm/companies?q=${encodeURIComponent('Off_Season')}`);
  assert.deepEqual(literalUnderscore.data.companies.map((company) => company.id), [first.data.id]);
  const parentheses = await call(`/v1/crm/companies?q=${encodeURIComponent('(Twin Cities)')}`);
  assert.deepEqual(new Set(parentheses.data.companies.map((company) => company.id)), new Set([first.data.id, second.data.id]));
});

test('prospect API searches existing records and creates, updates, and deduplicates prospect research records', async () => {
  const listed = await call('/v1/crm/prospects?q=northland');
  assert.equal(listed.response.status, 200);
  assert.equal(listed.data.prospects.length, 1);
  assert.equal(listed.data.prospects[0].company_name, 'Northland Ford');
  assert.equal(listed.data.prospects[0].company_id, companyOne);

  const company = await call('/v1/crm/companies', { method: 'POST', key: 'prospect-company-001', body: { name: 'Lakeview Auto', industry: 'Automotive', website: 'https://lakeview.example' } });
  assert.equal(company.response.status, 201);
  const body = { company_id: company.data.id, company_description: 'Minnesota dealership with a local community program.', fit_reason: 'Potential sports audience fit.', source_name: 'Company community page', source_url: 'https://lakeview.example/community', research_confidence: 'medium' };
  const created = await call('/v1/crm/prospects', { method: 'POST', key: 'prospect-create-001', body });
  const replay = await call('/v1/crm/prospects', { method: 'POST', key: 'prospect-create-001', body });
  assert.equal(created.response.status, 201);
  assert.equal(replay.response.headers.get('Idempotent-Replay'), 'true');
  assert.equal(replay.data.id, created.data.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_records WHERE entity_type='prospect' AND name='Lakeview Auto'").get().n, 1);
  assert.equal(db.prepare('SELECT company_id FROM sales_record_companies WHERE record_id=?').get(created.data.id).company_id, company.data.id);

  const updated = await call(`/v1/crm/prospects/${created.data.id}`, { method: 'PATCH', key: 'prospect-update-001', body: { campaign_opportunities: 'A locally sourced student-athlete feature.', researched_at: '2026-11-23' } });
  assert.equal(updated.response.status, 200);
  const searched = await call('/v1/crm/prospects?q=student-athlete');
  assert.equal(searched.data.prospects.length, 1);
  assert.equal(searched.data.prospects[0].campaign_opportunities, 'A locally sourced student-athlete feature.');
  const duplicate = await call('/v1/crm/prospects', { method: 'POST', key: 'prospect-create-002', body });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.id, created.data.id);
  const audit = db.prepare("SELECT COUNT(*) AS n FROM sales_audit_log WHERE action IN ('crm_prospect_created','crm_prospect_updated')").get().n;
  assert.equal(audit, 2);
});

test('prospect promotion preserves canonical contacts, research provenance, and communication history', async () => {
  const company = await call('/v1/crm/companies', { method: 'POST', key: 'promote-company-001', body: { name: 'Synthetic North Star Foods', industry: 'Food & Beverage', website: 'https://northstar.example' } });
  const prospect = await call('/v1/crm/prospects', { method: 'POST', key: 'promote-prospect-001', body: { company_id: company.data.id, fit_reason: 'Synthetic fit evidence', source_url: 'https://northstar.example/partners', research_confidence: 'high' } });
  const contact1 = await call('/v1/crm/contacts', { method: 'POST', key: 'promote-contact-001', body: { display_name: 'Riley Example', title: 'Partnerships Director', email: 'riley@northstar.example', company_ids: [company.data.id] } });
  const contact2 = await call('/v1/crm/contacts', { method: 'POST', key: 'promote-contact-002', body: { display_name: 'Jordan Example', title: 'Brand Manager', email: 'jordan@northstar.example', company_ids: [company.data.id] } });
  db.prepare(`INSERT INTO sales_communications (id,provider,gmail_message_id,gmail_thread_id,company_id,contact_id,direction,from_email,to_emails_json,cc_emails_json,subject,snippet,occurred_at,synced_at)
    VALUES ('synthetic-message','gmail','synthetic-msg-1','synthetic-thread-1',?,?,'received','riley@northstar.example','["crm@10ktakesmn.com"]','[]','Synthetic reply','Synthetic history test','2026-11-24T10:00:00Z','2026-11-24T10:01:00Z')`)
    .run(company.data.id, contact1.data.id);
  const promoted = await call(`/v1/crm/prospects/${prospect.data.id}/promote`, { method: 'POST', key: 'promote-lead-001', body: {} });
  assert.equal(promoted.response.status, 201);
  assert.equal(promoted.data.stage, 'New');
  const lead = db.prepare("SELECT * FROM sales_records WHERE id=? AND entity_type='lead'").get(promoted.data.id);
  const leadData = JSON.parse(lead.data_json);
  assert.equal(leadData.fit_reason, 'Synthetic fit evidence');
  assert.equal(db.prepare('SELECT company_id FROM sales_record_companies WHERE record_id=?').get(lead.id).company_id, company.data.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_company_contacts WHERE company_id=?').get(company.data.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_research_sources WHERE record_id=?').get(lead.id).n, 1);
  const history = await call(`/v1/crm/communications?company_id=${company.data.id}`);
  assert.equal(history.data.communications.filter((message) => message.provider === 'gmail').length, 1);
  const secondPromote = await call(`/v1/crm/prospects/${prospect.data.id}/promote`, { method: 'POST', key: 'promote-lead-002', body: {} });
  assert.equal(secondPromote.response.status, 409);
  assert.equal(secondPromote.data.id, lead.id);
  const audit = db.prepare("SELECT COUNT(*) AS n FROM sales_audit_log WHERE action='crm_prospect_promoted'").get().n;
  assert.equal(audit, 1);
  assert.notEqual(contact2.data.id, contact1.data.id);
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

test('standalone research notes can be read only with research:read scope', async () => {
  const note = await call('/v1/crm/research-notes', { method: 'POST', key: 'research-note-read-0001', body: { company_id: companyOne, note: 'Synthetic note for a read test.', source_url: 'https://example.com/research', title: 'Synthetic source', confidence: 'medium' } });
  assert.equal(note.response.status, 201);
  const researchReader = await addApiKey({ label: 'research reader', scopes: ['research:read'], token: 'research-reader-token-with-at-least-thirty-two-characters' });
  const allowed = await call(`/v1/crm/research-notes?company_id=${companyOne}`, { token: researchReader });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.data.notes.length, 1);
  assert.equal(allowed.data.notes[0].note, 'Synthetic note for a read test.');
  const denied = await call(`/v1/crm/research-notes?company_id=${companyOne}`, { token: await addApiKey({ label: 'company reader', scopes: ['companies:read'], token: 'company-reader-token-with-at-least-thirty-two-characters' }) });
  assert.equal(denied.response.status, 403);
  const missingCompany = await call('/v1/crm/research-notes');
  assert.equal(missingCompany.response.status, 400);
});

test('synthetic partnership lifecycle covers writes, deduplication, notes, and lead promotion', async () => {
  const company = await call('/v1/crm/companies', { method: 'POST', key: 'synthetic-lifecycle-company-001', body: { name: 'Synthetic Lifecycle QA', industry: 'Retail' } });
  assert.equal(company.response.status, 201);
  const contact = await call('/v1/crm/contacts', { method: 'POST', key: 'synthetic-lifecycle-contact-001', body: { display_name: 'Synthetic QA Contact', title: 'Partnerships Manager', email: 'synthetic.qa@example.invalid', company_ids: [company.data.id] } });
  assert.equal(contact.response.status, 201);
  const secondContact = await call('/v1/crm/contacts', { method: 'POST', key: 'synthetic-lifecycle-contact-002', body: { display_name: 'Second Synthetic Contact', title: 'Brand Manager', company_ids: [company.data.id] } });
  assert.equal(secondContact.response.status, 201);
  assert.notEqual(secondContact.data.id, contact.data.id);
  const duplicateContact = await call('/v1/crm/contacts', { method: 'POST', key: 'synthetic-lifecycle-contact-duplicate', body: { display_name: 'Duplicate Synthetic Contact', email: 'SYNTHETIC.QA@example.invalid', company_ids: [company.data.id] } });
  assert.equal(duplicateContact.response.status, 200);
  assert.equal(duplicateContact.data.id, contact.data.id);
  assert.equal(duplicateContact.data.matched_existing, true);
  const prospectBody = { company_id: company.data.id, fit_reason: 'Synthetic fit reason.', source_name: 'Synthetic QA source', source_url: 'https://example.invalid/qa', research_confidence: 'medium' };
  const prospect = await call('/v1/crm/prospects', { method: 'POST', key: 'synthetic-lifecycle-prospect-001', body: prospectBody });
  assert.equal(prospect.response.status, 201);
  const duplicateProspect = await call('/v1/crm/prospects', { method: 'POST', key: 'synthetic-lifecycle-prospect-002', body: prospectBody });
  assert.equal(duplicateProspect.response.status, 409);
  assert.equal(duplicateProspect.data.id, prospect.data.id);
  const contactUpdate = await call(`/v1/crm/contacts/${contact.data.id}`, { method: 'PATCH', key: 'synthetic-lifecycle-contact-update', body: { title: 'Senior Partnerships Manager' } });
  assert.equal(contactUpdate.response.status, 200);
  const prospectUpdate = await call(`/v1/crm/prospects/${prospect.data.id}`, { method: 'PATCH', key: 'synthetic-lifecycle-prospect-update', body: { campaign_opportunities: 'Synthetic campaign concept.' } });
  assert.equal(prospectUpdate.response.status, 200);
  const companyUpdate = await call(`/v1/crm/companies/${company.data.id}`, { method: 'PATCH', key: 'synthetic-lifecycle-company-update', body: { website: 'https://synthetic.example.invalid' } });
  assert.equal(companyUpdate.response.status, 200);
  const standaloneNote = await call('/v1/crm/research-notes', { method: 'POST', key: 'synthetic-lifecycle-note-create', body: { company_id: company.data.id, note: 'Synthetic standalone research note.', source_url: 'https://example.invalid/notes' } });
  assert.equal(standaloneNote.response.status, 201);
  const noteList = await call(`/v1/crm/research-notes?company_id=${company.data.id}`);
  assert.equal(noteList.response.status, 200);
  assert.equal(noteList.data.notes.some((item) => item.id === standaloneNote.data.id), true);
  const promoted = await call(`/v1/crm/prospects/${prospect.data.id}/promote`, { method: 'POST', key: 'synthetic-lifecycle-promote', body: {} });
  assert.equal(promoted.response.status, 201);
  assert.equal(promoted.data.stage, 'New');
  const promotionDuplicate = await call(`/v1/crm/prospects/${prospect.data.id}/promote`, { method: 'POST', key: 'synthetic-lifecycle-promote-again', body: {} });
  assert.equal(promotionDuplicate.response.status, 409);
  assert.equal(promotionDuplicate.data.id, promoted.data.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_records WHERE entity_type='lead' AND id=?").get(promoted.data.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_audit_log WHERE entity_id IN (?,?,?)").get(company.data.id, contact.data.id, prospect.data.id).n >= 5, true);
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
  db.prepare(`INSERT INTO sales_communications (id,provider,gmail_message_id,gmail_thread_id,company_id,record_id,direction,from_email,subject,snippet,occurred_at,synced_at,deleted_at)
    VALUES ('gmail-deleted','gmail','message-deleted','thread-deleted',?,?,'received','contact@example.com','Old reply','Soft-deleted message',?,?,?)`).run(companyOne, leadId, now, now, now);
  db.prepare("INSERT INTO outreach_log (id,lead_id,recipient,subject,body,provider_id,sent_at) VALUES ('resend-1',?,'prospect@example.com','Pitch','Resend copy','resend-message-1',?)").run(leadId, now);
  db.prepare("INSERT INTO sales_activities (id,record_id,activity_type,summary,occurred_at,created_at) VALUES ('resend-activity-1',?,'email_sent','Sent via Resend',?,?)").run(leadId, now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_communications WHERE provider='gmail' AND gmail_message_id='message-1'").get().n, 1);
  const history = await call(`/v1/crm/communications?company_id=${companyOne}`);
  assert.equal(history.data.communications.length, 2);
  assert.deepEqual(new Set(history.data.communications.map((message) => message.provider)), new Set(['gmail', 'resend']));
  assert.equal(history.data.communications.some((message) => message.message_id === 'message-deleted'), false, 'soft-deleted Gmail messages are excluded from history');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sales_activities WHERE activity_type='email_sent'").get().n, 1);
});

test('existing dashboard Sales API remains available with its existing named token and origin check', async () => {
  const ok = await call('/v1/sales/records?type=lead', { origin: 'https://10000takes.github.io' });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.data.records.length, 1);
  const denied = await call('/v1/sales/records?type=lead', { origin: 'https://attacker.example' });
  assert.equal(denied.response.status, 403);
});
