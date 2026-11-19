const MAILBOX = "partnerships@10ktakesmn.com";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const PAGE_SIZE = 100;
const MESSAGE_BUDGET_PER_RUN = 30;

interface D1Result<T = unknown> { results?: T[] }
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface GmailEnv {
  DB: { prepare(sql: string): D1Statement };
  PUBLIC_READ_ORIGIN?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  SALES_JACK_TOKEN?: string;
  SALES_CODY_TOKEN?: string;
}
interface GmailActor { id: string; display_name: string; role: string; legacy: boolean }
interface GmailMessage { id: string; threadId?: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } }

const json = (data: unknown, status = 200, headers: HeadersInit = {}): Response => {
  const merged = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Response(JSON.stringify(data), { status, headers: merged });
};

const fail = (message: string, status = 400): Response => json({ error: message }, status);
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const fromB64url = (value: string): Uint8Array => {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(standard + "=".repeat((4 - standard.length % 4) % 4));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};
const randomToken = (bytes = 32): string => {
  const value = new Uint8Array(bytes); crypto.getRandomValues(value); return b64url(value);
};
const sha256 = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

function encryptionKey(env: GmailEnv): Promise<CryptoKey> {
  if (!env.GMAIL_TOKEN_ENCRYPTION_KEY) throw new Error("Gmail token encryption is not configured.");
  const bytes = fromB64url(env.GMAIL_TOKEN_ENCRYPTION_KEY);
  if (bytes.byteLength !== 32) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSecret(env: GmailEnv, value: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await encryptionKey(env), nonceBytes = new Uint8Array(12); crypto.getRandomValues(nonceBytes);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceBytes as BufferSource }, key, new TextEncoder().encode(value) as BufferSource);
  return { ciphertext: b64url(new Uint8Array(ciphertext)), nonce: b64url(nonceBytes) };
}

async function decryptSecret(env: GmailEnv, ciphertext: string, nonce: string): Promise<string> {
  const key = await encryptionKey(env);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(nonce) as BufferSource }, key, fromB64url(ciphertext) as BufferSource);
  return new TextDecoder().decode(clear);
}

function oauthReady(env: GmailEnv): boolean {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.GMAIL_TOKEN_ENCRYPTION_KEY) return false;
  try {
    const redirect = new URL(env.GOOGLE_OAUTH_REDIRECT_URI);
    return redirect.protocol === "https:" && redirect.pathname === "/v1/sales/gmail/callback" && !redirect.search && !redirect.hash;
  } catch { return false; }
}

function mailboxPage(title: string, text: string, status = 200): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title></head><body style="font:16px system-ui;max-width:42rem;margin:10vh auto;padding:1rem;color:#18232c"><h1>${escape(title)}</h1><p>${escape(text)}</p><p>You can close this tab.</p></body></html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
  });
}

async function audit(env: GmailEnv, actorId: string, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare(`INSERT INTO sales_audit_log (id,actor_id,action,entity_type,entity_id,metadata_json,created_at)
    VALUES (?,?,?,'gmail_mailbox',?,?,?)`).bind(crypto.randomUUID(), actorId, action, MAILBOX, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function allowGmailRequest(env: GmailEnv, actor: GmailActor, path: string): Promise<boolean> {
  const principal = `gmail:${actor.id}:${path.endsWith('/sync') ? 'sync' : 'control'}`;
  const windowStart = Math.floor(Date.now() / 60_000);
  const result = await env.DB.prepare(`INSERT INTO sales_crm_rate_limits(principal_id,window_start,request_count)
    VALUES(?,?,1) ON CONFLICT(principal_id,window_start) DO UPDATE SET request_count=request_count+1
    RETURNING request_count`).bind(principal, windowStart).all<{ request_count: number }>();
  const maximum = path.endsWith('/sync') ? 4 : 30;
  if (windowStart % 60 === 0) await env.DB.prepare("DELETE FROM sales_crm_rate_limits WHERE principal_id=? AND window_start<?").bind(principal, windowStart - 60).run();
  return Number(result.results?.[0]?.request_count ?? maximum + 1) <= maximum;
}

async function createConnectUrl(env: GmailEnv, actor: GmailActor): Promise<string> {
  if (!oauthReady(env)) throw new Error("Set the four Gmail OAuth/encryption Worker settings before connecting.");
  const state = randomToken(), verifier = randomToken(48), challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const encrypted = await encryptSecret(env, verifier), created = new Date(), expires = new Date(created.getTime() + 10 * 60_000);
  await env.DB.prepare(`INSERT INTO sales_gmail_oauth_states(state_sha256,pkce_verifier_ciphertext,pkce_verifier_nonce,actor_id,created_at,expires_at)
    VALUES(?,?,?,?,?,?)`).bind(await sha256(state), encrypted.ciphertext, encrypted.nonce, actor.id, created.toISOString(), expires.toISOString()).run();
  await env.DB.prepare("DELETE FROM sales_gmail_oauth_states WHERE expires_at < ? OR consumed_at IS NOT NULL").bind(created.toISOString()).run();
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("hd", "10ktakesmn.com");
  url.searchParams.set("login_hint", MAILBOX);
  return url.toString();
}

async function exchangeCode(env: GmailEnv, code: string, verifier: string): Promise<Record<string, unknown>> {
  const form = new URLSearchParams({
    code, client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI!, grant_type: "authorization_code", code_verifier: verifier,
  });
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof result.access_token !== "string") throw new Error("Google did not complete mailbox authorization.");
  return result;
}

async function googleRequest<T>(accessToken: string, url: URL | string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!response.ok) {
    const safeText = response.status === 401 ? "Gmail authorization expired or was revoked." : response.status === 404 ? "Gmail history or message is no longer available." : `Gmail API returned HTTP ${response.status}.`;
    const error = new Error(safeText) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

async function refreshAccessToken(env: GmailEnv): Promise<{ accessToken: string; row: Record<string, unknown> }> {
  const result = await env.DB.prepare(`SELECT mailbox_email,refresh_token_ciphertext,refresh_token_nonce,status
    FROM sales_gmail_oauth_credentials WHERE mailbox_email=?`).bind(MAILBOX).all<Record<string, unknown>>();
  const row = result.results?.[0];
  if (!row || row.status !== "connected") throw new Error("Gmail mailbox is not connected.");
  const refreshToken = await decryptSecret(env, String(row.refresh_token_ciphertext), String(row.refresh_token_nonce));
  const form = new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID!, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: "refresh_token" });
  const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const resultBody = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof resultBody.access_token !== "string") {
    if (response.status === 400 || response.status === 401) {
      await env.DB.prepare("UPDATE sales_gmail_oauth_credentials SET status='error',error_summary='Google refresh authorization failed.',updated_at=? WHERE mailbox_email=?").bind(new Date().toISOString(), MAILBOX).run();
      await env.DB.prepare("UPDATE sales_gmail_sync_state SET status='error',error_summary='Google refresh authorization failed.',updated_at=? WHERE mailbox_email=?").bind(new Date().toISOString(), MAILBOX).run();
    }
    throw new Error("Could not refresh Google authorization. Reconnect the mailbox.");
  }
  return { accessToken: String(resultBody.access_token), row };
}

function getHeaders(message: GmailMessage): Map<string, string> {
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) headers.set(header.name.toLowerCase(), header.value);
  return headers;
}

function addressEmails(value: string): string[] {
  const matches = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) ?? [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function emailName(value: string): string {
  const angle = value.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
  return (angle?.[1] ?? "").trim().slice(0, 160);
}

function isoDate(message: GmailMessage, dateHeader: string): string {
  const millis = Number(message.internalDate);
  if (Number.isFinite(millis) && millis > 0) return new Date(millis).toISOString();
  const parsed = Date.parse(dateHeader);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function addBusinessDays(start: Date, businessDays: number): string {
  const result = new Date(start);
  let remaining = businessDays;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return result.toISOString().slice(0, 10);
}

async function findLink(env: GmailEnv, emails: string[]): Promise<{ contactId: string | null; companyId: string | null; recordId: string | null }> {
  for (const email of emails) {
    const result = await env.DB.prepare(`SELECT e.contact_id,cc.company_id,rc.record_id
      FROM sales_contact_emails e
      LEFT JOIN sales_company_contacts cc ON cc.contact_id=e.contact_id
      LEFT JOIN sales_record_companies rc ON rc.company_id=cc.company_id
      LEFT JOIN sales_records r ON r.id=rc.record_id
      WHERE e.normalized_email=?
      ORDER BY CASE WHEN r.entity_type='lead' THEN 0 WHEN r.entity_type='client' THEN 1 ELSE 2 END,cc.is_primary DESC
      LIMIT 1`).bind(email).all<Record<string, unknown>>();
    if (result.results?.length) {
      const row = result.results[0];
      return { contactId: String(row.contact_id), companyId: row.company_id ? String(row.company_id) : null, recordId: row.record_id ? String(row.record_id) : null };
    }
  }
  const domains = [...new Set(emails.map((email) => email.split("@")[1]).filter((domain) => Boolean(domain)))];
  if (domains.length) {
    const companies = await env.DB.prepare(`SELECT c.id AS company_id,rc.record_id,c.website
      FROM sales_companies c LEFT JOIN sales_record_companies rc ON rc.company_id=c.id
      WHERE c.website<>'' ORDER BY c.updated_at DESC`).all<Record<string, unknown>>();
    for (const row of companies.results ?? []) {
      try {
        const host = new URL(String(row.website).includes("://") ? String(row.website) : `https://${row.website}`).hostname.toLowerCase().replace(/^www\./, "");
        if (domains.includes(host)) return { contactId: null, companyId: String(row.company_id), recordId: row.record_id ? String(row.record_id) : null };
      } catch { /* Ignore malformed website values. */ }
    }
  }
  return { contactId: null, companyId: null, recordId: null };
}

async function inheritThreadLink(env: GmailEnv, threadId: string): Promise<{ contactId: string | null; companyId: string | null; recordId: string | null }> {
  const result = await env.DB.prepare(`SELECT contact_id,company_id,record_id FROM sales_communications
    WHERE provider='gmail' AND gmail_thread_id=? AND deleted_at IS NULL AND (company_id IS NOT NULL OR contact_id IS NOT NULL)
    ORDER BY occurred_at LIMIT 1`).bind(threadId).all<Record<string, unknown>>();
  const row = result.results?.[0];
  return row ? { contactId: row.contact_id ? String(row.contact_id) : null, companyId: row.company_id ? String(row.company_id) : null, recordId: row.record_id ? String(row.record_id) : null } : { contactId: null, companyId: null, recordId: null };
}

async function syncOneMessage(env: GmailEnv, accessToken: string, messageId: string): Promise<{ matched: boolean; direction?: string; deleted?: boolean }> {
  const url = new URL(`${GMAIL_API}/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const name of ["From", "To", "Cc", "Subject", "Date", "Message-ID", "In-Reply-To", "References"]) url.searchParams.append("metadataHeaders", name);
  let message: GmailMessage;
  try { message = await googleRequest<GmailMessage>(accessToken, url); }
  catch (error) {
    if ((error as Error & { status?: number }).status === 404) {
      await env.DB.prepare("UPDATE sales_communications SET deleted_at=? WHERE provider='gmail' AND gmail_message_id=? AND deleted_at IS NULL").bind(new Date().toISOString(), messageId).run();
      return { matched: false, deleted: true };
    }
    throw error;
  }
  const headers = getHeaders(message), fromRaw = headers.get("from") ?? "", toRaw = headers.get("to") ?? "", ccRaw = headers.get("cc") ?? "";
  const mailbox = MAILBOX, fromEmails = addressEmails(fromRaw), toEmails = addressEmails(toRaw), ccEmails = addressEmails(ccRaw);
  const labels = [...new Set(message.labelIds ?? [])];
  const isDraft = labels.includes("DRAFT");
  const direction = isDraft ? "draft" : labels.includes("SENT") || fromEmails.includes(mailbox) ? "sent" : "received";
  const externalEmails = direction === "received" ? fromEmails.filter((email) => email !== mailbox) : [...toEmails, ...ccEmails].filter((email) => email !== mailbox);
  let link = await findLink(env, externalEmails);
  if (!link.contactId && message.threadId) link = await inheritThreadLink(env, message.threadId);
  // Do not retain unrelated mailbox metadata. Only CRM-linked people, known company domains,
  // or messages in an already linked thread enter the CRM communication history.
  if (!link.contactId && !link.companyId) return { matched: false, direction, deleted: false };
  const threadId = message.threadId ?? message.id;
  const date = isoDate(message, headers.get("date") ?? "");
  const id = `gmail:${message.id}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO sales_communications (id,provider,gmail_message_id,gmail_thread_id,company_id,record_id,contact_id,direction,from_email,to_emails_json,cc_emails_json,subject,snippet,body_ciphertext,body_nonce,occurred_at,synced_at,gmail_label_ids_json,deleted_at)
    VALUES (?,'gmail',?,?,?,?,?,?,?,?,?,?, '', '', '', ?,?,?,NULL)
    ON CONFLICT(provider,gmail_message_id) DO UPDATE SET gmail_thread_id=excluded.gmail_thread_id,company_id=COALESCE(excluded.company_id,sales_communications.company_id),record_id=COALESCE(excluded.record_id,sales_communications.record_id),contact_id=COALESCE(excluded.contact_id,sales_communications.contact_id),direction=excluded.direction,from_email=excluded.from_email,to_emails_json=excluded.to_emails_json,cc_emails_json=excluded.cc_emails_json,subject=excluded.subject,occurred_at=excluded.occurred_at,synced_at=excluded.synced_at,gmail_label_ids_json=excluded.gmail_label_ids_json,deleted_at=NULL`)
    .bind(id, message.id, threadId, link.companyId, link.recordId, link.contactId, direction, fromEmails[0] ?? "", JSON.stringify(toEmails), JSON.stringify(ccEmails), (headers.get("subject") ?? "").slice(0, 500), date, now, JSON.stringify(labels)).run();

  if (direction === "received" && message.threadId && link.companyId && link.contactId) {
    await env.DB.prepare(`UPDATE sales_follow_up_tasks SET status='cancelled',cancelled_at=?,updated_at=?
      WHERE status='open' AND company_id=? AND (contact_id=? OR contact_id IS NULL)
      AND source_communication_id IN (SELECT id FROM sales_communications WHERE provider='gmail' AND gmail_thread_id=?)`)
      .bind(now, now, link.companyId, link.contactId, message.threadId).run();
  }
  if (direction === "sent" && !isDraft && link.companyId && link.contactId && message.threadId) {
    const dedupeKey = `gmail-followup:${message.id}`;
    const prior = await env.DB.prepare("SELECT id FROM sales_follow_up_tasks WHERE dedupe_key=?").bind(dedupeKey).all();
    if (!prior.results?.length) {
      await env.DB.prepare(`UPDATE sales_follow_up_tasks SET status='cancelled',cancelled_at=?,updated_at=?
        WHERE status='open' AND company_id=? AND (contact_id=? OR contact_id IS NULL)
        AND source_communication_id IN (SELECT id FROM sales_communications WHERE provider='gmail' AND gmail_thread_id=?)`)
        .bind(now, now, link.companyId, link.contactId, message.threadId).run();
      const taskId = crypto.randomUUID();
      await env.DB.prepare(`INSERT OR IGNORE INTO sales_follow_up_tasks (id,company_id,record_id,contact_id,source_communication_id,task_type,title,notes,assigned_to,due_at,status,generated_by,dedupe_key,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'follow_up','Follow up on Gmail conversation','No reply has been recorded in this Gmail thread. Review the thread before contacting the prospect.','',?,'open','gmail_sync',?,'gmail_sync',?,?)`)
        .bind(taskId, link.companyId, link.recordId, link.contactId, id, addBusinessDays(new Date(date), 4), dedupeKey, now, now).run();
    }
  }
  return { matched: Boolean(link.companyId || link.contactId), direction, deleted: false };
}

async function enqueueHistory(env: GmailEnv, accessToken: string): Promise<number> {
  const state = await env.DB.prepare("SELECT history_id,history_page_token FROM sales_gmail_sync_state WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
  const row = state.results?.[0];
  if (!row?.history_id) return 0;
  const url = new URL(`${GMAIL_API}/history`);
  url.searchParams.set("startHistoryId", String(row.history_id));
  url.searchParams.set("maxResults", "100");
  if (row.history_page_token) url.searchParams.set("pageToken", String(row.history_page_token));
  let history: Record<string, unknown>;
  try { history = await googleRequest<Record<string, unknown>>(accessToken, url); }
  catch (error) {
    if ((error as Error & { status?: number }).status === 404 && !row.history_page_token) {
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE sales_gmail_sync_state SET initial_page_token='',initial_sync_complete=0,initial_sync_started_at=?,history_page_token='',status='syncing',error_summary='',updated_at=? WHERE mailbox_email=?`)
        .bind(now, now, MAILBOX).run();
      return 0;
    }
    throw error;
  }
  const items = Array.isArray(history.history) ? history.history as Array<Record<string, unknown>> : [];
  const ids = new Set<string>();
  for (const item of items) {
    for (const key of ["messages", "messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"]) {
      const list = item[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const msg = (entry as Record<string, unknown>).message && typeof (entry as Record<string, unknown>).message === "object" ? (entry as Record<string, unknown>).message as Record<string, unknown> : entry as Record<string, unknown>;
        if (typeof msg.id === "string") ids.add(msg.id);
      }
    }
  }
  const now = new Date().toISOString();
  for (const id of ids) await env.DB.prepare("INSERT OR IGNORE INTO sales_gmail_sync_queue(mailbox_email,gmail_message_id,created_at) VALUES(?,?,?)").bind(MAILBOX, id, now).run();
  const nextPage = typeof history.nextPageToken === "string" ? history.nextPageToken : "";
  const nextHistoryId = typeof history.historyId === "string" ? history.historyId : String(row.history_id);
  await env.DB.prepare(`UPDATE sales_gmail_sync_state SET history_page_token=?,history_id=CASE WHEN ?='' THEN ? ELSE history_id END,updated_at=? WHERE mailbox_email=?`)
    .bind(nextPage, nextPage, nextHistoryId, now, MAILBOX).run();
  return ids.size;
}

async function fillInitialQueue(env: GmailEnv, accessToken: string): Promise<number> {
  const state = await env.DB.prepare("SELECT initial_page_token FROM sales_gmail_sync_state WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
  const cursor = String(state.results?.[0]?.initial_page_token ?? "");
  const url = new URL(`${GMAIL_API}/messages`);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  if (cursor) url.searchParams.set("pageToken", cursor);
  const page = await googleRequest<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(accessToken, url);
  const now = new Date().toISOString();
  for (const message of page.messages ?? []) {
    if (message.id) await env.DB.prepare("INSERT OR IGNORE INTO sales_gmail_sync_queue(mailbox_email,gmail_message_id,created_at) VALUES(?,?,?)").bind(MAILBOX, message.id, now).run();
  }
  const next = page.nextPageToken ?? "";
  await env.DB.prepare(`UPDATE sales_gmail_sync_state SET initial_page_token=?,initial_sync_complete=?,status=?,updated_at=? WHERE mailbox_email=?`)
    .bind(next, next ? 0 : 1, next ? "syncing" : "connected", now, MAILBOX).run();
  return page.messages?.length ?? 0;
}

export async function runGmailSync(env: GmailEnv): Promise<Record<string, number | string>> {
  if (!oauthReady(env)) throw new Error("Gmail OAuth and encryption secrets are not configured.");
  const stamp = new Date().toISOString();
  const state = await env.DB.prepare("SELECT status,initial_sync_complete,history_page_token FROM sales_gmail_sync_state WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
  if (!state.results?.length) throw new Error("Gmail mailbox is not connected.");
  await env.DB.prepare("UPDATE sales_gmail_sync_state SET status='syncing',last_attempt_at=?,error_summary='',updated_at=? WHERE mailbox_email=?").bind(stamp, stamp, MAILBOX).run();
  const { accessToken } = await refreshAccessToken(env);
  let queuedFromGmail = 0;
  if (Number(state.results[0].initial_sync_complete) !== 1) queuedFromGmail = await fillInitialQueue(env, accessToken);
  else if (String(state.results[0].history_page_token ?? "") || (await env.DB.prepare("SELECT COUNT(*) AS count FROM sales_gmail_sync_queue WHERE mailbox_email=?").bind(MAILBOX).all<{ count: number }>()).results?.[0]?.count === 0) {
    queuedFromGmail = await enqueueHistory(env, accessToken);
  }
  const pending = await env.DB.prepare("SELECT gmail_message_id FROM sales_gmail_sync_queue WHERE mailbox_email=? ORDER BY created_at,gmail_message_id LIMIT ?")
    .bind(MAILBOX, MESSAGE_BUDGET_PER_RUN).all<{ gmail_message_id: string }>();
  let matched = 0, processed = 0, deleted = 0, unmatched = 0;
  for (const item of pending.results ?? []) {
    const outcome = await syncOneMessage(env, accessToken, item.gmail_message_id);
    if (outcome.matched) matched++;
    else if (!outcome.deleted) unmatched++;
    if (outcome.deleted) deleted++;
    processed++;
    await env.DB.prepare("DELETE FROM sales_gmail_sync_queue WHERE mailbox_email=? AND gmail_message_id=?").bind(MAILBOX, item.gmail_message_id).run();
  }
  const remain = await env.DB.prepare("SELECT COUNT(*) AS count FROM sales_gmail_sync_queue WHERE mailbox_email=?").bind(MAILBOX).all<{ count: number }>();
  const latest = await env.DB.prepare("SELECT initial_sync_complete FROM sales_gmail_sync_state WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
  const status = Number(remain.results?.[0]?.count) > 0 || Number(latest.results?.[0]?.initial_sync_complete) !== 1 ? "syncing" : "connected";
  const counts = { processed, matched, unmatched, deleted, queued: queuedFromGmail, pending: Number(remain.results?.[0]?.count ?? 0) };
  const finished = new Date().toISOString();
  await env.DB.prepare("UPDATE sales_gmail_sync_state SET status=?,last_success_at=?,last_sync_counts_json=?,error_summary='',updated_at=? WHERE mailbox_email=?")
    .bind(status, finished, JSON.stringify(counts), finished, MAILBOX).run();
  return counts;
}

function authorizedHeaders(request: Request, cors: HeadersInit): Headers {
  const headers = new Headers(cors);
  headers.set("Cache-Control", "no-store");
  if (request.headers.get("Origin") && !headers.has("Access-Control-Allow-Origin")) throw new Error("Origin not allowed.");
  return headers;
}

export async function handleGmailRoute(request: Request, env: GmailEnv, url: URL, actor: GmailActor, cors: HeadersInit): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "");
  try {
    const headers = authorizedHeaders(request, cors);
    if (actor.legacy) return fail("Gmail access requires a named-user account.", 403);
    if (!(await allowGmailRequest(env, actor, path))) {
      const rateHeaders = new Headers(cors); rateHeaders.set("Retry-After", "60");
      return json({ error: "Gmail endpoint rate limit exceeded. Retry next minute." }, 429, rateHeaders);
    }
    if (request.method === "GET" && path === "/v1/sales/gmail/status") {
      const result = await env.DB.prepare(`SELECT s.mailbox_email,s.status,s.last_success_at,s.last_attempt_at,s.error_summary,s.initial_sync_complete,s.last_sync_counts_json,c.scopes_json,c.connected_at,c.status AS credential_status
        FROM sales_gmail_sync_state s LEFT JOIN sales_gmail_oauth_credentials c ON c.mailbox_email=s.mailbox_email WHERE s.mailbox_email=?`).bind(MAILBOX).all<Record<string, unknown>>();
      const row = result.results?.[0];
      return json({ configured: oauthReady(env), mailbox: row ? { email: row.mailbox_email, status: row.status, credential_status: row.credential_status, last_success_at: row.last_success_at, last_attempt_at: row.last_attempt_at, error: row.error_summary || null, initial_sync_complete: Number(row.initial_sync_complete) === 1, last_sync_counts: safeJson(row.last_sync_counts_json, {}), scopes: safeJson(row.scopes_json, []), connected_at: row.connected_at } : null }, 200, headers);
    }
    if (request.method === "GET" && path === "/v1/sales/gmail/communications") {
      const recordId = String(url.searchParams.get("record_id") ?? "").trim().slice(0, 80);
      if (!recordId) return fail("record_id is required.");
      const record = await env.DB.prepare("SELECT id FROM sales_records WHERE id=? AND entity_type IN ('lead','prospect','client')").bind(recordId).all<Record<string, unknown>>();
      if (!record.results?.length) return fail("CRM record not found.", 404);
      const rows = await env.DB.prepare(`SELECT id,provider,gmail_message_id AS message_id,gmail_thread_id AS thread_id,gmail_draft_id AS draft_id,direction,from_email,to_emails_json,cc_emails_json,subject,snippet,occurred_at
        FROM sales_communications WHERE record_id=? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 100`).bind(recordId).all<Record<string, unknown>>();
      const resend = await env.DB.prepare(`SELECT id,'resend' AS provider,provider_id AS message_id,'' AS thread_id,'' AS draft_id,'sent' AS direction,'' AS from_email,json_array(recipient) AS to_emails_json,'[]' AS cc_emails_json,subject,body AS snippet,sent_at AS occurred_at
        FROM outreach_log WHERE lead_id=? ORDER BY sent_at DESC LIMIT 100`).bind(recordId).all<Record<string, unknown>>();
      const communications = [...(rows.results ?? []), ...(resend.results ?? [])].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 100);
      const next = await env.DB.prepare("SELECT MIN(due_at) AS due_at FROM sales_follow_up_tasks WHERE record_id=? AND status='open'").bind(recordId).all<Record<string, unknown>>();
      const lastContacted = communications.find((item) => item.direction === "sent")?.occurred_at ?? null;
      const lastReply = communications.find((item) => item.provider === "gmail" && item.direction === "received")?.occurred_at ?? null;
      return json({ communications, last_contacted_at: lastContacted, last_reply_at: lastReply, next_follow_up_at: next.results?.[0]?.due_at ?? null, note: "Gmail sent, replies, and draft labels come from Gmail metadata. Resend history remains separate." }, 200, headers);
    }
    if (request.method === "POST" && path === "/v1/sales/gmail/connect") {
      if (actor.role !== "sales_admin" || actor.id !== "jack") return fail("Only the sales administrator can connect the shared mailbox.", 403);
      const authorizationUrl = await createConnectUrl(env, actor);
      await audit(env, actor.id, "gmail_oauth_started", { mailbox: MAILBOX, scope: "gmail.metadata" });
      return json({ authorization_url: authorizationUrl, mailbox: MAILBOX, scope: GMAIL_SCOPE }, 200, headers);
    }
    if (request.method === "POST" && path === "/v1/sales/gmail/sync") {
      try {
        if (url.searchParams.get("rescan") === "1") {
          if (actor.id !== "jack" || actor.role !== "sales_admin") return fail("Only the sales administrator can restart historical reconciliation.", 403);
          const now = new Date().toISOString();
          await env.DB.prepare("DELETE FROM sales_gmail_sync_queue WHERE mailbox_email=?").bind(MAILBOX).run();
          await env.DB.prepare("UPDATE sales_gmail_sync_state SET initial_page_token='',initial_sync_complete=0,initial_sync_started_at=?,history_page_token='',status='syncing',error_summary='',updated_at=? WHERE mailbox_email=?").bind(now, now, MAILBOX).run();
        }
        const result = await runGmailSync(env);
        await audit(env, actor.id, url.searchParams.get("rescan") === "1" ? "gmail_history_rescan_requested" : "gmail_sync_requested", { mailbox: MAILBOX, ...result });
        return json({ synced: true, ...result }, 200, headers);
      } catch (error) {
        const now = new Date().toISOString(), message = error instanceof Error ? error.message.slice(0, 180) : "Gmail synchronization failed.";
        await env.DB.prepare("UPDATE sales_gmail_sync_state SET status='error',error_summary=?,last_attempt_at=?,updated_at=? WHERE mailbox_email=?").bind(message, now, now, MAILBOX).run();
        throw error;
      }
    }
    if (request.method === "POST" && path === "/v1/sales/gmail/disconnect") {
      if (actor.role !== "sales_admin" || actor.id !== "jack") return fail("Only the sales administrator can disconnect the shared mailbox.", 403);
      const row = await env.DB.prepare("SELECT refresh_token_ciphertext,refresh_token_nonce FROM sales_gmail_oauth_credentials WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
      if (row.results?.[0]) {
        const refresh = await decryptSecret(env, String(row.results[0].refresh_token_ciphertext), String(row.results[0].refresh_token_nonce));
        await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }) });
      }
      await env.DB.prepare("DELETE FROM sales_gmail_oauth_credentials WHERE mailbox_email=?").bind(MAILBOX).run();
      await env.DB.prepare("DELETE FROM sales_gmail_sync_state WHERE mailbox_email=?").bind(MAILBOX).run();
      await audit(env, actor.id, "gmail_mailbox_disconnected", { mailbox: MAILBOX });
      return json({ disconnected: true }, 200, headers);
    }
    return fail("Not found.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gmail request failed.";
    return json({ error: message.slice(0, 240) }, message === "Origin not allowed." ? 403 : 400, cors);
  }
}

function safeJson(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export async function handleGmailCallback(request: Request, env: GmailEnv): Promise<Response> {
  if (request.method !== "GET") return mailboxPage("Gmail connection failed", "This callback only accepts Google's authorization response.", 405);
  if (!oauthReady(env)) return mailboxPage("Gmail connection unavailable", "OAuth settings are not configured on the Worker.", 503);
  const actual = new URL(request.url), expected = new URL(env.GOOGLE_OAUTH_REDIRECT_URI!);
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return mailboxPage("Gmail connection failed", "The OAuth callback URL does not match the configured redirect URI.", 400);
  const state = actual.searchParams.get("state") ?? "";
  if (state.length < 32 || state.length > 256) return mailboxPage("Gmail connection failed", "The authorization state is invalid or expired.", 400);
  const hashed = await sha256(state), now = new Date().toISOString();
  const states = await env.DB.prepare(`UPDATE sales_gmail_oauth_states SET consumed_at=?
    WHERE state_sha256=? AND consumed_at IS NULL AND expires_at>? RETURNING pkce_verifier_ciphertext,pkce_verifier_nonce,actor_id`)
    .bind(now, hashed, now).all<Record<string, unknown>>();
  const saved = states.results?.[0];
  if (!saved) return mailboxPage("Gmail connection failed", "The authorization state was already used or expired. Start the connection again.", 400);
  const actorState = await env.DB.prepare("SELECT active,role FROM sales_users WHERE id=?").bind(String(saved.actor_id)).all<Record<string, unknown>>();
  if (Number(actorState.results?.[0]?.active) !== 1 || String(actorState.results?.[0]?.role) !== "sales_admin") return mailboxPage("Gmail connection failed", "The authorizing user is no longer permitted to connect this mailbox.", 403);
  const oauthError = actual.searchParams.get("error");
  if (oauthError) return mailboxPage("Gmail connection cancelled", "No Gmail connection was stored. You can close this tab.", 400);
  const code = actual.searchParams.get("code") ?? "";
  if (!code) return mailboxPage("Gmail connection failed", "Google did not return an authorization code.", 400);
  let tokenToRevoke = "";
  try {
    const verifier = await decryptSecret(env, String(saved.pkce_verifier_ciphertext), String(saved.pkce_verifier_nonce));
    const token = await exchangeCode(env, code, verifier);
    tokenToRevoke = String(token.refresh_token ?? token.access_token ?? "");
    const grantedScopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : [GMAIL_SCOPE];
    if (grantedScopes.length !== 1 || grantedScopes[0] !== GMAIL_SCOPE) {
      await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: String(token.refresh_token ?? token.access_token) }) });
      tokenToRevoke = "";
      return mailboxPage("Gmail connection failed", "Google returned a different or broader permission set. No mailbox token was stored.", 403);
    }
    const profile = await googleRequest<{ emailAddress?: string; historyId?: string }>(String(token.access_token), `${GMAIL_API}/profile`);
    const mailbox = (profile.emailAddress ?? "").toLowerCase();
    if (mailbox !== MAILBOX) {
      await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: String(token.refresh_token ?? token.access_token) }) });
      tokenToRevoke = "";
      return mailboxPage("Wrong Gmail account", `Connect ${MAILBOX}. The account you authorized was not stored.`, 403);
    }
    const prior = await env.DB.prepare("SELECT refresh_token_ciphertext,refresh_token_nonce FROM sales_gmail_oauth_credentials WHERE mailbox_email=?").bind(MAILBOX).all<Record<string, unknown>>();
    let encrypted: { ciphertext: string; nonce: string };
    if (typeof token.refresh_token === "string" && token.refresh_token.length > 0) encrypted = await encryptSecret(env, token.refresh_token);
    else if (prior.results?.[0]) encrypted = { ciphertext: String(prior.results[0].refresh_token_ciphertext), nonce: String(prior.results[0].refresh_token_nonce) };
    else throw new Error("Google did not issue a refresh token. Revoke the previous app access and connect again.");
    const connected = new Date().toISOString(), historyId = String(profile.historyId ?? "");
    await env.DB.prepare(`INSERT INTO sales_gmail_oauth_credentials(mailbox_email,refresh_token_ciphertext,refresh_token_nonce,scopes_json,connected_by,connected_at,updated_at,status,error_summary)
      VALUES(?,?,?,?,?,?,?,'connected','') ON CONFLICT(mailbox_email) DO UPDATE SET refresh_token_ciphertext=excluded.refresh_token_ciphertext,refresh_token_nonce=excluded.refresh_token_nonce,scopes_json=excluded.scopes_json,connected_by=excluded.connected_by,connected_at=excluded.connected_at,updated_at=excluded.updated_at,status='connected',error_summary=''`)
      .bind(MAILBOX, encrypted.ciphertext, encrypted.nonce, JSON.stringify([GMAIL_SCOPE]), String(saved.actor_id), connected, connected).run();
    await env.DB.prepare(`INSERT INTO sales_gmail_sync_state(mailbox_email,history_id,last_success_at,last_attempt_at,status,error_summary,updated_at,initial_page_token,initial_sync_complete,initial_sync_started_at,history_page_token,last_sync_counts_json)
      VALUES(?,?,NULL,NULL,'syncing','',?,'',0,?,'','{}') ON CONFLICT(mailbox_email) DO UPDATE SET history_id=excluded.history_id,status='syncing',error_summary='',initial_page_token='',initial_sync_complete=0,initial_sync_started_at=excluded.initial_sync_started_at,history_page_token='',updated_at=excluded.updated_at`)
      .bind(MAILBOX, historyId, connected, connected).run();
    tokenToRevoke = "";
    await audit(env, String(saved.actor_id), "gmail_mailbox_connected", { mailbox: MAILBOX, scopes: ["gmail.metadata"] });
    return mailboxPage("Gmail connected", `${MAILBOX} is connected with metadata-only, read-only access. Initial reconciliation will run in the background.`);
  } catch {
    if (tokenToRevoke) {
      try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokenToRevoke }) }); } catch { /* Do not expose OAuth tokens in callback errors. */ }
    }
    return mailboxPage("Gmail connection failed", "Google authorization could not be completed. No token values were displayed or logged; review Worker configuration and try again.", 400);
  }
}

export async function scheduledGmailSync(env: GmailEnv): Promise<void> {
  const status = await env.DB.prepare(`SELECT s.status,c.status AS credential_status FROM sales_gmail_sync_state s
    JOIN sales_gmail_oauth_credentials c ON c.mailbox_email=s.mailbox_email WHERE s.mailbox_email=?`).bind(MAILBOX).all<Record<string, unknown>>();
  if (status.results?.[0]?.credential_status === "connected") {
    try {
      const result = await runGmailSync(env);
      await audit(env, "system:gmail_sync", "gmail_sync_scheduled", { mailbox: MAILBOX, ...result });
    }
    catch (error) {
      const reason = error instanceof Error && /history or message/.test(error.message) ? "Gmail history needs a fresh reconciliation." : error instanceof Error ? error.message.slice(0, 180) : "Gmail synchronization failed.";
      const now = new Date().toISOString();
      await env.DB.prepare("UPDATE sales_gmail_sync_state SET status='error',error_summary=?,last_attempt_at=?,updated_at=? WHERE mailbox_email=?").bind(reason, now, now, MAILBOX).run();
      await audit(env, "system:gmail_sync", "gmail_sync_scheduled_failed", { mailbox: MAILBOX, error: reason });
    }
  }
}
