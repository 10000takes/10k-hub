import { handleGmailCallback, handleGmailRoute, scheduledGmailSync } from "./gmail";

interface D1Result<T = unknown> { results?: T[] }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
interface Env {
  DB: D1Database;
  SALES_API_TOKEN?: string;
  SALES_JACK_TOKEN?: string;
  SALES_CODY_TOKEN?: string;
  PUBLIC_READ_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  OAUTH_KV: { get(key: string, type: "json"): Promise<Record<string, unknown> | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>; delete(key: string): Promise<void> };
  MCP_SERVER_URL?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_CRM_API_BASE_URL?: string;
  MCP_CRM_API_TOKEN?: string;
  MCP_AUTH_PASSWORD?: string;
}

interface SalesActor { id: string; display_name: string; role: string; legacy: boolean }

const SALES_TYPES = new Set(["client", "lead", "prospect"]);
const SALES_STAGES = new Set(["New", "Contacted", "Proposal Sent", "Closed"]);
const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers(jsonHeaders);
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Response(JSON.stringify(data), { status, headers: merged });
}

function dateOnly(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${name} is not a valid date`);
  return value;
}

function sameSecret(supplied: string, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const expected = `Bearer ${token}`;
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function identifyActor(request: Request, env: Env): SalesActor | null {
  const supplied = request.headers.get("Authorization") ?? "";
  if (sameSecret(supplied, env.SALES_JACK_TOKEN)) return { id: "jack", display_name: "Jack Leverentz", role: "sales_admin", legacy: false };
  if (sameSecret(supplied, env.SALES_CODY_TOKEN)) return { id: "cody", display_name: "Cody", role: "sales_lead", legacy: false };
  // Keep existing CRM access working during rollout, but the shared credential cannot send email.
  if (!env.SALES_JACK_TOKEN && !env.SALES_CODY_TOKEN && sameSecret(supplied, env.SALES_API_TOKEN)) {
    return { id: "legacy_shared", display_name: "Legacy shared access", role: "legacy", legacy: true };
  }
  return null;
}

async function audit(env: Env, actor: SalesActor, action: string, entityType = "", entityId = "", metadata: Record<string, unknown> = {}): Promise<void> {
  await env.DB.prepare("INSERT INTO sales_audit_log (id, actor_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), actor.id, action, entityType, entityId, JSON.stringify(metadata), new Date().toISOString()).run();
}

const CRM_SCOPES = new Set([
  "companies:read", "companies:write", "contacts:read", "contacts:write",
  "prospects:read", "prospects:write",
  "communications:read", "research:read", "research:write", "opportunities:read",
  "opportunities:write", "tasks:read", "tasks:write",
]);
const CRM_USER_SCOPES = [...CRM_SCOPES];

interface CrmPrincipal extends SalesActor {
  scopes: string[];
  rateLimit: number;
  ownerId: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authenticateCrm(request: Request, env: Env): Promise<CrmPrincipal | null> {
  const human = identifyActor(request, env);
  if (human && !human.legacy) return { ...human, scopes: CRM_USER_SCOPES, rateLimit: 120, ownerId: human.id };
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]{32,256})$/);
  if (!match) return null;
  const tokenHash = await sha256Hex(match[1]);
  const result = await env.DB.prepare(`SELECT id, label, scopes_json, rate_limit_per_minute, created_by
    FROM sales_crm_api_credentials
    WHERE token_sha256=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    LIMIT 1`).bind(tokenHash, new Date().toISOString()).all<Record<string, unknown>>();
  const credential = result.results?.[0];
  if (!credential) return null;
  const owner = await env.DB.prepare("SELECT active FROM sales_users WHERE id=?").bind(String(credential.created_by)).all<Record<string, unknown>>();
  if (Number(owner.results?.[0]?.active) !== 1) return null;
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(String(credential.scopes_json || "[]"));
    if (Array.isArray(parsed)) scopes = parsed.filter((scope): scope is string => typeof scope === "string" && CRM_SCOPES.has(scope));
  } catch { return null; }
  return {
    id: `crm_api:${String(credential.id)}`,
    display_name: String(credential.label || "CRM integration"),
    role: "crm_api",
    legacy: false,
    scopes,
    rateLimit: Math.max(1, Math.min(600, Number(credential.rate_limit_per_minute) || 60)),
    ownerId: String(credential.created_by),
  };
}

async function consumeCrmRateLimit(env: Env, actor: CrmPrincipal): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 60_000);
  const result = await env.DB.prepare(`INSERT INTO sales_crm_rate_limits (principal_id, window_start, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(principal_id, window_start) DO UPDATE SET request_count=request_count+1
    RETURNING request_count`).bind(actor.id, windowStart).all<{ request_count: number }>();
  if (windowStart % 60 === 0) {
    await env.DB.prepare("DELETE FROM sales_crm_rate_limits WHERE principal_id=? AND window_start < ?").bind(actor.id, windowStart - 60).run();
  }
  return Number(result.results?.[0]?.request_count ?? actor.rateLimit + 1) <= actor.rateLimit;
}

function crmScope(actor: CrmPrincipal, scope: string): boolean {
  return actor.scopes.includes(scope);
}

async function auditCrm(env: Env, actor: CrmPrincipal, action: string, entityType = "", entityId = "", metadata: Record<string, unknown> = {}): Promise<void> {
  await audit(env, actor, action, entityType, entityId, { ...metadata, integration_owner: actor.ownerId });
}

async function idempotentCrmWrite(
  request: Request,
  env: Env,
  actor: CrmPrincipal,
  routeKey: string,
  execute: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{12,128}$/.test(key)) return json({ error: "A unique Idempotency-Key (12–128 characters) is required for CRM writes." }, 400);
  const raw = await request.text();
  if (raw.length > 30_000) return json({ error: "Request body must be under 30 KB." }, 413);
  let body: Record<string, unknown>;
  try { body = salesObject(JSON.parse(raw)); } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid JSON body." }, 400); }
  const requestHash = await sha256Hex(raw);
  const now = new Date().toISOString();
  const reserve = await env.DB.prepare(`INSERT INTO sales_crm_idempotency
    (principal_id,idempotency_key,route_key,request_sha256,state,created_at,updated_at,expires_at)
    VALUES (?,?,?,?,'processing',?,?,?) ON CONFLICT(principal_id,idempotency_key) DO NOTHING
    RETURNING idempotency_key`).bind(actor.id, key, routeKey, requestHash, now, now, new Date(Date.now() + 86_400_000).toISOString()).all();
  if (!reserve.results?.length) {
    const old = await env.DB.prepare(`SELECT route_key,request_sha256,state,response_status,response_json,updated_at
      FROM sales_crm_idempotency WHERE principal_id=? AND idempotency_key=?`).bind(actor.id, key).all<Record<string, unknown>>();
    const prior = old.results?.[0];
    if (!prior || prior.route_key !== routeKey || prior.request_sha256 !== requestHash) return json({ error: "Idempotency-Key was already used for a different request." }, 409);
    if (prior.state === "complete") {
      return json(JSON.parse(String(prior.response_json || "{}")), Number(prior.response_status) || 200, { "Idempotent-Replay": "true" });
    }
    if (Date.now() - Date.parse(String(prior.updated_at)) < 10 * 60_000) return json({ error: "This request is already being processed. Retry with the same key shortly." }, 409);
    const reclaimed = await env.DB.prepare(`UPDATE sales_crm_idempotency SET updated_at=?
      WHERE principal_id=? AND idempotency_key=? AND state='processing' AND updated_at=? RETURNING idempotency_key`)
      .bind(now, actor.id, key, String(prior.updated_at)).all();
    if (!reclaimed.results?.length) return json({ error: "This request is already being processed. Retry with the same key shortly." }, 409);
  }
  let response: Response;
  try {
    response = await execute(body);
    const responseText = await response.clone().text();
    const safeResponse = responseText.length <= 30_000 ? responseText : JSON.stringify({ error: "Response exceeds idempotency cache limit." });
    await env.DB.prepare(`UPDATE sales_crm_idempotency SET state='complete',response_status=?,response_json=?,updated_at=?
      WHERE principal_id=? AND idempotency_key=?`).bind(response.status, safeResponse, new Date().toISOString(), actor.id, key).run();
    return response;
  } catch (error) {
    await env.DB.prepare("DELETE FROM sales_crm_idempotency WHERE principal_id=? AND idempotency_key=? AND state='processing'").bind(actor.id, key).run();
    throw error;
  }
}

function crmContactValidEmail(value: unknown): string {
  const email = salesString(value, "", 254).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Provide a valid contact email address.");
  return email;
}

async function crmRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const actor = await authenticateCrm(request, env);
  if (!actor) return json({ error: "Unauthorized. Use a named-user token or a scoped CRM integration key." }, 401);
  if (!(await consumeCrmRateLimit(env, actor))) return json({ error: "Rate limit exceeded. Retry after the current minute." }, 429, { "Retry-After": String(60 - Math.floor((Date.now() % 60_000) / 1000)) });
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, "");
  const requireScope = (scope: string) => crmScope(actor, scope) ? null : json({ error: `Missing required scope: ${scope}` }, 403);
  try {
    if (path === "/v1/crm/companies" && method === "GET") {
      const denied = requireScope("companies:read"); if (denied) return denied;
      const q = salesString(url.searchParams.get("q"), "", 160).toLowerCase();
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
      const rows = await env.DB.prepare(`SELECT c.id,c.name AS company_name,c.industry,c.website,c.notes,c.updated_at,
        COUNT(DISTINCT r.id) AS linked_record_count,
        GROUP_CONCAT(DISTINCT r.entity_type) AS record_types
        FROM sales_companies c LEFT JOIN sales_record_companies rc ON rc.company_id=c.id
        LEFT JOIN sales_records r ON r.id=rc.record_id
        WHERE (?='' OR lower(c.name) LIKE ?)
        GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?`).bind(q, `%${q}%`, limit).all();
      return json({ companies: rows.results ?? [] });
    }
    if (path === "/v1/crm/companies" && method === "POST") {
      const denied = requireScope("companies:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (body) => {
        const name = salesString(body.name ?? body.company_name, "", 160);
        if (!name) return json({ error: "name is required" }, 400);
        const normalized = name.trim().toLowerCase();
        const dupe = await env.DB.prepare("SELECT id FROM sales_companies WHERE normalized_name=? LIMIT 1").bind(normalized).all<Record<string, unknown>>();
        if (dupe.results?.length) return json({ error: "Company already exists.", id: dupe.results[0].id }, 409);
        const id = crypto.randomUUID(), now = new Date().toISOString();
        try {
          await env.DB.prepare(`INSERT INTO sales_companies (id,name,normalized_name,website,industry,notes,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?)`).bind(id, name, normalized, salesString(body.website, "", 1000), salesString(body.industry, "", 100), salesString(body.notes, "", 2000), now, now).run();
        } catch (error) {
          const duplicate = await env.DB.prepare("SELECT id FROM sales_companies WHERE normalized_name=?").bind(normalized).all<Record<string, unknown>>();
          if (duplicate.results?.length) return json({ error: "Company already exists.", id: duplicate.results[0].id }, 409);
          throw error;
        }
        await auditCrm(env, actor, "crm_company_created", "company", id, { company_name: name });
        return json({ id, company_name: name, created_at: now }, 201);
      });
    }
    const companyMatch = path.match(/^\/v1\/crm\/companies\/([\w-]+)$/);
    if (companyMatch && method === "PATCH") {
      const denied = requireScope("companies:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (patch) => {
        const existing = await env.DB.prepare("SELECT * FROM sales_companies WHERE id=?").bind(companyMatch[1]).all<Record<string, unknown>>();
        const row = existing.results?.[0]; if (!row) return json({ error: "Company not found." }, 404);
        const allowed = new Set(["name", "website", "industry", "notes"]);
        const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
        if (unknown.length) return json({ error: `Unsupported company fields: ${unknown.join(", ")}` }, 400);
        const name = salesString(patch.name, String(row.name), 160);
        if (!name) return json({ error: "name cannot be empty." }, 400);
        const normalized = name.trim().toLowerCase();
        const now = new Date().toISOString();
        const collision = await env.DB.prepare("SELECT id FROM sales_companies WHERE normalized_name=? AND id<>? LIMIT 1").bind(normalized, companyMatch[1]).all();
        if (collision.results?.length) return json({ error: "Another company already uses that name." }, 409);
        await env.DB.prepare("UPDATE sales_companies SET name=?,normalized_name=?,website=?,industry=?,notes=?,updated_at=? WHERE id=?")
          .bind(name, normalized, salesString(patch.website, String(row.website), 1000), salesString(patch.industry, String(row.industry), 100), salesString(patch.notes, String(row.notes), 2000), now, companyMatch[1]).run();
        if (Object.prototype.hasOwnProperty.call(patch, "name")) await env.DB.prepare(`UPDATE sales_records SET name=?,data_json=json_set(data_json,'$.company_name',?),updated_at=?
          WHERE id IN (SELECT record_id FROM sales_record_companies WHERE company_id=?)`).bind(name, name, now, companyMatch[1]).run();
        if (Object.prototype.hasOwnProperty.call(patch, "industry")) await env.DB.prepare(`UPDATE sales_records SET industry=?,data_json=json_set(data_json,'$.industry',?),updated_at=?
          WHERE id IN (SELECT record_id FROM sales_record_companies WHERE company_id=?)`).bind(salesString(patch.industry, "", 100), salesString(patch.industry, "", 100), now, companyMatch[1]).run();
        await auditCrm(env, actor, "crm_company_updated", "company", companyMatch[1], { changed_fields: Object.keys(patch) });
        return json({ id: companyMatch[1], company_name: name, updated_at: now });
      });
    }
    if (path === "/v1/crm/prospects" && method === "GET") {
      const denied = requireScope("prospects:read"); if (denied) return denied;
      const q = salesString(url.searchParams.get("q"), "", 160).toLowerCase();
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
      const rows = await env.DB.prepare(`SELECT r.id,rc.company_id,COALESCE(c.name,r.name) AS company_name,
        COALESCE(NULLIF(r.industry,''),c.industry,'') AS industry,r.status,r.updated_at,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.company_description'),'') AS company_description,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.fit_reason'),'') AS fit_reason,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.campaign_opportunities'),'') AS campaign_opportunities,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.lead_category'),'brand') AS lead_category,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.location'),'') AS location,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.source_name'),'') AS source_name,
        COALESCE((SELECT s.url FROM sales_research_sources s WHERE s.record_id=r.id ORDER BY s.captured_at DESC LIMIT 1),
          json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.source_url'),'') AS source_url,
        COALESCE((SELECT s.confidence FROM sales_research_sources s WHERE s.record_id=r.id ORDER BY s.captured_at DESC LIMIT 1),
          json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.research_confidence'),'unverified') AS research_confidence,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.researched_at'),'') AS researched_at,
        COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.notes'),'') AS notes,
        c.website
        FROM sales_records r
        LEFT JOIN sales_record_companies rc ON rc.record_id=r.id
        LEFT JOIN sales_companies c ON c.id=rc.company_id
        WHERE r.entity_type='prospect' AND (?='' OR lower(COALESCE(c.name,r.name)) LIKE ?
          OR lower(COALESCE(r.industry,c.industry,'')) LIKE ?
          OR lower(COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.company_description'),'')) LIKE ?
          OR lower(COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.fit_reason'),'')) LIKE ?
          OR lower(COALESCE(json_extract(CASE WHEN json_valid(r.data_json) THEN r.data_json ELSE '{}' END,'$.campaign_opportunities'),'')) LIKE ?)
        ORDER BY r.updated_at DESC LIMIT ?`).bind(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, limit).all();
      return json({ prospects: rows.results ?? [] });
    }
    if (path === "/v1/crm/prospects" && method === "POST") {
      const denied = requireScope("prospects:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (body) => {
        const companyId = salesString(body.company_id, "", 80);
        if (!companyId) return json({ error: "company_id is required. Create or find the canonical company first." }, 400);
        const allowed = new Set(["company_id", "company_description", "fit_reason", "campaign_opportunities", "lead_category", "location", "source_name", "source_url", "research_confidence", "researched_at", "notes"]);
        const unknown = Object.keys(body).filter((key) => !allowed.has(key));
        if (unknown.length) return json({ error: `Unsupported prospect fields: ${unknown.join(", ")}` }, 400);
        const companyResult = await env.DB.prepare("SELECT id,name,industry FROM sales_companies WHERE id=?").bind(companyId).all<Record<string, unknown>>();
        const company = companyResult.results?.[0];
        if (!company) return json({ error: "Canonical company not found." }, 404);
        const existing = await env.DB.prepare(`SELECT r.id FROM sales_records r JOIN sales_record_companies rc ON rc.record_id=r.id
          WHERE r.entity_type='prospect' AND rc.company_id=? LIMIT 1`).bind(companyId).all<Record<string, unknown>>();
        if (existing.results?.length) return json({ error: "A prospect research record already exists for this company.", id: existing.results[0].id }, 409);
        const sourceUrl = salesString(body.source_url, "", 1000);
        if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) return json({ error: "source_url must use HTTPS." }, 400);
        const confidence = String(body.research_confidence || (sourceUrl ? "low" : "unverified"));
        if (!["unverified", "low", "medium", "high"].includes(confidence)) return json({ error: "research_confidence must be unverified, low, medium, or high." }, 400);
        const category = String(body.lead_category || "brand").toLowerCase();
        if (!["brand", "agency"].includes(category)) return json({ error: "lead_category must be brand or agency." }, 400);
        const researchedAt = body.researched_at ? dateOnly(body.researched_at, "researched_at") : new Date().toISOString().slice(0, 10);
        const now = new Date().toISOString(), id = crypto.randomUUID();
        const data = {
          company_name: String(company.name), company_description: salesString(body.company_description, "", 1000),
          fit_reason: salesString(body.fit_reason, "", 1000), campaign_opportunities: salesString(body.campaign_opportunities, "", 1000),
          lead_category: category, location: salesString(body.location, "", 160), source_name: salesString(body.source_name, "", 160),
          source_url: sourceUrl, research_confidence: confidence, researched_at: researchedAt, notes: salesString(body.notes, "", 2000),
        };
        await env.DB.prepare(`INSERT INTO sales_records (id,entity_type,name,stage,industry,status,monthly_revenue,total_value,probability,next_follow_up,contract_end,last_contact,data_json,created_at,updated_at)
          VALUES (?,'prospect',?,'',?,'open',0,0,0,NULL,NULL,NULL,?,?,?)`).bind(id, String(company.name), String(company.industry || ""), JSON.stringify(data), now, now).run();
        await env.DB.prepare("INSERT INTO sales_record_companies (record_id,company_id,created_at) VALUES (?,?,?)").bind(id, companyId, now).run();
        if (sourceUrl) await env.DB.prepare(`INSERT INTO sales_research_sources (id,record_id,source_type,title,url,fact_summary,confidence,captured_at,added_by)
          VALUES (?,?,'prospect_research',?,?,?,?,?,?)`).bind(crypto.randomUUID(), id, data.source_name || "Prospect research source", sourceUrl, data.company_description, confidence, now, actor.ownerId).run();
        await auditCrm(env, actor, "crm_prospect_created", "prospect", id, { company_id: companyId, company_name: String(company.name), source_url: sourceUrl || null });
        return json({ id, company_id: companyId, company_name: String(company.name), created_at: now }, 201);
      });
    }
    const prospectMatch = path.match(/^\/v1\/crm\/prospects\/([\w-]+)$/);
    if (prospectMatch && method === "PATCH") {
      const denied = requireScope("prospects:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (patch) => {
        const old = await env.DB.prepare(`SELECT r.*,rc.company_id FROM sales_records r LEFT JOIN sales_record_companies rc ON rc.record_id=r.id
          WHERE r.id=? AND r.entity_type='prospect'`).bind(prospectMatch[1]).all<Record<string, unknown>>();
        const row = old.results?.[0]; if (!row) return json({ error: "Prospect not found." }, 404);
        const allowed = new Set(["company_description", "fit_reason", "campaign_opportunities", "lead_category", "location", "source_name", "source_url", "research_confidence", "researched_at", "notes"]);
        const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
        if (unknown.length) return json({ error: `Unsupported prospect fields: ${unknown.join(", ")}` }, 400);
        let previous: Record<string, unknown> = {}; try { previous = JSON.parse(String(row.data_json || "{}")); } catch { previous = {}; }
        const next = { ...previous };
        for (const [key, max] of [["company_description", 1000], ["fit_reason", 1000], ["campaign_opportunities", 1000], ["location", 160], ["source_name", 160], ["notes", 2000]] as const) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = salesString(patch[key], "", max);
        }
        if (Object.prototype.hasOwnProperty.call(patch, "lead_category")) {
          const category = String(patch.lead_category || "").toLowerCase();
          if (!["brand", "agency"].includes(category)) return json({ error: "lead_category must be brand or agency." }, 400);
          next.lead_category = category;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "source_url")) {
          const sourceUrl = salesString(patch.source_url, "", 1000);
          if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) return json({ error: "source_url must use HTTPS." }, 400);
          next.source_url = sourceUrl;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "research_confidence")) {
          const confidence = String(patch.research_confidence || "");
          if (!["unverified", "low", "medium", "high"].includes(confidence)) return json({ error: "research_confidence must be unverified, low, medium, or high." }, 400);
          next.research_confidence = confidence;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "researched_at")) next.researched_at = patch.researched_at ? dateOnly(patch.researched_at, "researched_at") : "";
        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE sales_records SET data_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(next), now, prospectMatch[1]).run();
        const sourceChanged = next.source_url && (next.source_url !== previous.source_url || next.source_name !== previous.source_name || next.company_description !== previous.company_description || next.research_confidence !== previous.research_confidence);
        if (sourceChanged) await env.DB.prepare(`INSERT INTO sales_research_sources (id,record_id,source_type,title,url,fact_summary,confidence,captured_at,added_by)
          VALUES (?,?,'prospect_research',?,?,?,?,?,?)`).bind(crypto.randomUUID(), prospectMatch[1], salesString(next.source_name, "Prospect research source", 160), String(next.source_url), salesString(next.company_description, "", 1000), String(next.research_confidence || "unverified"), now, actor.ownerId).run();
        await auditCrm(env, actor, "crm_prospect_updated", "prospect", prospectMatch[1], { changed_fields: Object.keys(patch), company_id: row.company_id || null });
        return json({ id: prospectMatch[1], company_id: row.company_id || null, updated_at: now });
      });
    }
    const prospectPromoteMatch = path.match(/^\/v1\/crm\/prospects\/([\w-]+)\/promote$/);
    if (prospectPromoteMatch && method === "POST") {
      const prospectDenied = requireScope("prospects:write"); if (prospectDenied) return prospectDenied;
      const opportunityDenied = requireScope("opportunities:write"); if (opportunityDenied) return opportunityDenied;
      return idempotentCrmWrite(request, env, actor, path, async () => {
        const sourceResult = await env.DB.prepare(`SELECT r.*,rc.company_id,c.name AS canonical_name,c.industry AS canonical_industry
          FROM sales_records r LEFT JOIN sales_record_companies rc ON rc.record_id=r.id
          LEFT JOIN sales_companies c ON c.id=rc.company_id
          WHERE r.id=? AND r.entity_type='prospect'`).bind(prospectPromoteMatch[1]).all<Record<string, unknown>>();
        const prospect = sourceResult.results?.[0];
        if (!prospect) return json({ error: "Prospect not found." }, 404);
        if (!prospect.company_id) return json({ error: "Prospect must be linked to a canonical company before promotion." }, 409);
        const duplicate = await env.DB.prepare(`SELECT r.id FROM sales_records r LEFT JOIN sales_record_companies rc ON rc.record_id=r.id
          WHERE r.entity_type='lead' AND (rc.company_id=? OR lower(r.name)=lower(?)) LIMIT 1`)
          .bind(prospect.company_id, String(prospect.canonical_name || prospect.name)).all<Record<string, unknown>>();
        if (duplicate.results?.length) return json({ error: "An active lead already exists for this company.", id: duplicate.results[0].id }, 409);
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(String(prospect.data_json || "{}")); } catch { data = {}; }
        const companyName = String(prospect.canonical_name || prospect.name);
        const now = new Date().toISOString(), leadId = crypto.randomUUID();
        const leadData = {
          ...data,
          company_name: companyName,
          stage: "New",
          status: "open",
          lead_source: `Brand Discovery: ${salesString(data.source_name, "manual research", 160)}`,
          fit_explanation: salesString(data.fit_reason, "", 1000),
          probability: 20,
        };
        await env.DB.prepare(`INSERT INTO sales_records (id,entity_type,name,stage,industry,status,monthly_revenue,total_value,probability,next_follow_up,contract_end,last_contact,data_json,created_at,updated_at)
          VALUES (?,'lead',?,'New',?,'open',?,?,20,NULL,NULL,NULL,?,?,?)`)
          .bind(leadId, companyName, String(prospect.canonical_industry || prospect.industry || ""),
            salesNumber(data.estimated_monthly_value), salesNumber(data.estimated_total_value), JSON.stringify(leadData), now, now).run();
        await env.DB.prepare("INSERT INTO sales_record_companies (record_id,company_id,created_at) VALUES (?,?,?)")
          .bind(leadId, String(prospect.company_id), now).run();
        await env.DB.prepare(`INSERT INTO sales_research_sources (id,record_id,source_type,title,url,fact_summary,confidence,captured_at,added_by)
          SELECT lower(hex(randomblob(16))),?,source_type,title,url,fact_summary,confidence,captured_at,added_by
          FROM sales_research_sources WHERE record_id=?`).bind(leadId, prospectPromoteMatch[1]).run();
        await auditCrm(env, actor, "crm_prospect_promoted", "lead", leadId, { prospect_id: prospectPromoteMatch[1], company_id: prospect.company_id });
        return json({ id: leadId, prospect_id: prospectPromoteMatch[1], company_id: prospect.company_id, company_name: companyName, stage: "New", created_at: now }, 201);
      });
    }
    if (path === "/v1/crm/contacts" && method === "GET") {
      const denied = requireScope("contacts:read"); if (denied) return denied;
      const q = salesString(url.searchParams.get("q"), "", 160).toLowerCase();
      const companyId = salesString(url.searchParams.get("company_id"), "", 80);
      const rows = await env.DB.prepare(`SELECT c.id,c.display_name,c.title,c.phone,c.notes,c.updated_at,
        e.email,e.is_primary,rc.company_id, r.name AS company_name,rc.relationship_role,rc.is_primary AS company_primary
        FROM sales_contacts c
        LEFT JOIN sales_contact_emails e ON e.contact_id=c.id
        LEFT JOIN sales_company_contacts rc ON rc.contact_id=c.id
        LEFT JOIN sales_companies r ON r.id=rc.company_id
        WHERE (?='' OR lower(c.display_name) LIKE ? OR lower(COALESCE(e.normalized_email,'')) LIKE ?)
          AND (?='' OR rc.company_id=?)
        ORDER BY c.display_name,e.is_primary DESC LIMIT 500`).bind(q, `%${q}%`, `%${q}%`, companyId, companyId).all();
      return json({ contacts: rows.results ?? [] });
    }
    if (path === "/v1/crm/contacts" && method === "POST") {
      const denied = requireScope("contacts:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (body) => {
        const displayName = salesString(body.display_name ?? body.name, "", 160);
        if (!displayName) return json({ error: "display_name is required." }, 400);
        const email = crmContactValidEmail(body.email);
        const emailSourceUrl = salesString(body.email_source_url, "", 1000);
        if (emailSourceUrl && !/^https:\/\//i.test(emailSourceUrl)) return json({ error: "email_source_url must use HTTPS." }, 400);
        const confidence = String(body.confidence || "unverified");
        if (!["unverified", "low", "medium", "high"].includes(confidence)) return json({ error: "confidence must be unverified, low, medium, or high." }, 400);
        const companyIds = Array.isArray(body.company_ids) ? [...new Set(body.company_ids.map((v) => salesString(v, "", 80)).filter(Boolean))] : [];
        if (!email && !companyIds.length) return json({ error: "Provide an email or at least one company_id so the contact can be deduplicated and linked." }, 400);
        if (companyIds.length) {
          const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sales_companies WHERE id IN (${companyIds.map(() => "?").join(",")})`).bind(...companyIds).all<{ n: number }>();
          if (Number(found.results?.[0]?.n) !== companyIds.length) return json({ error: "One or more company_ids were not found." }, 404);
        }
        const now = new Date().toISOString();
        let contactId = "", matched = false;
        if (email) {
          const existing = await env.DB.prepare("SELECT contact_id FROM sales_contact_emails WHERE normalized_email=? LIMIT 1").bind(email).all<Record<string, unknown>>();
          if (existing.results?.length) { contactId = String(existing.results[0].contact_id); matched = true; }
        }
        if (!contactId) {
          contactId = crypto.randomUUID();
          await env.DB.prepare("INSERT INTO sales_contacts (id,display_name,title,phone,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
            .bind(contactId, displayName, salesString(body.title, "", 160), salesString(body.phone, "", 80), salesString(body.notes, "", 2000), now, now).run();
          if (email) {
            try {
              await env.DB.prepare("INSERT INTO sales_contact_emails (id,contact_id,email,normalized_email,is_primary,verification_source_url,confidence,created_at) VALUES (?,?,?,?,1,?,?,?)")
                .bind(crypto.randomUUID(), contactId, email, email, emailSourceUrl, confidence, now).run();
            } catch (error) {
              await env.DB.prepare("DELETE FROM sales_contacts WHERE id=?").bind(contactId).run();
              const duplicate = await env.DB.prepare("SELECT contact_id FROM sales_contact_emails WHERE normalized_email=?").bind(email).all<Record<string, unknown>>();
              if (duplicate.results?.length) return json({ error: "That email address already belongs to another CRM contact.", id: duplicate.results[0].contact_id }, 409);
              throw error;
            }
          }
        }
        for (const companyId of companyIds) {
          await env.DB.prepare("INSERT OR IGNORE INTO sales_company_contacts (company_id,contact_id,relationship_role,is_primary,created_at) VALUES (?,?,?,?,?)")
            .bind(companyId, contactId, salesString(body.relationship_role, "", 160), body.is_primary === true ? 1 : 0, now).run();
        }
        await auditCrm(env, actor, matched ? "crm_contact_linked" : "crm_contact_created", "contact", contactId, { email: email || "", company_ids: companyIds, matched_existing: matched });
        return json({ id: contactId, display_name: displayName, email: email || null, company_ids: companyIds, matched_existing: matched }, matched ? 200 : 201);
      });
    }
    const contactMatch = path.match(/^\/v1\/crm\/contacts\/([\w-]+)$/);
    if (contactMatch && method === "PATCH") {
      const denied = requireScope("contacts:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (patch) => {
        const existing = await env.DB.prepare("SELECT id FROM sales_contacts WHERE id=?").bind(contactMatch[1]).all();
        if (!existing.results?.length) return json({ error: "Contact not found." }, 404);
        const assignments: string[] = [], values: unknown[] = [];
        for (const [key, column, max] of [["display_name", "display_name", 160], ["title", "title", 160], ["phone", "phone", 80], ["notes", "notes", 2000]] as const) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) { const value = salesString(patch[key], "", max); if (key === "display_name" && !value) return json({ error: "display_name cannot be empty." }, 400); assignments.push(`${column}=?`); values.push(value); }
        }
        if (Object.prototype.hasOwnProperty.call(patch, "email")) {
          const email = crmContactValidEmail(patch.email);
          if (!email) return json({ error: "Contact email cannot be removed; set a replacement or leave it unchanged." }, 400);
          const now = new Date().toISOString();
          const confidence = String(patch.confidence || "unverified");
          const emailSourceUrl = salesString(patch.email_source_url, "", 1000);
          if (!["unverified", "low", "medium", "high"].includes(confidence)) return json({ error: "confidence must be unverified, low, medium, or high." }, 400);
          if (emailSourceUrl && !/^https:\/\//i.test(emailSourceUrl)) return json({ error: "email_source_url must use HTTPS." }, 400);
          await env.DB.prepare("UPDATE sales_contact_emails SET is_primary=0 WHERE contact_id=?").bind(contactMatch[1]).run();
          const saved = await env.DB.prepare("INSERT INTO sales_contact_emails (id,contact_id,email,normalized_email,is_primary,verification_source_url,confidence,created_at) VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(normalized_email) DO UPDATE SET is_primary=CASE WHEN contact_id=excluded.contact_id THEN 1 ELSE is_primary END RETURNING contact_id")
            .bind(crypto.randomUUID(), contactMatch[1], email, email, emailSourceUrl, confidence, now).all<Record<string, unknown>>();
          if (saved.results?.[0]?.contact_id !== contactMatch[1]) return json({ error: "That email address is already assigned to a different contact." }, 409);
        }
        assignments.push("updated_at=?"); values.push(new Date().toISOString()); values.push(contactMatch[1]);
        if (assignments.length) await env.DB.prepare(`UPDATE sales_contacts SET ${assignments.join(",")} WHERE id=?`).bind(...values).run();
        await auditCrm(env, actor, "crm_contact_updated", "contact", contactMatch[1], { changed_fields: Object.keys(patch) });
        return json({ id: contactMatch[1], updated_at: new Date().toISOString() });
      });
    }
    if (path === "/v1/crm/research-notes" && method === "POST") {
      const denied = requireScope("research:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (body) => {
        const companyId = salesString(body.company_id, "", 80), note = salesString(body.note, "", 2000);
        if (!companyId || !note) return json({ error: "company_id and note are required." }, 400);
        const found = await env.DB.prepare("SELECT id FROM sales_companies WHERE id=?").bind(companyId).all();
        if (!found.results?.length) return json({ error: "Company not found." }, 404);
        const sourceUrl = salesString(body.source_url, "", 1000);
        const confidence = String(body.confidence || "unverified");
        if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) return json({ error: "source_url must use HTTPS." }, 400);
        if (!["unverified", "low", "medium", "high"].includes(confidence)) return json({ error: "confidence must be unverified, low, medium, or high." }, 400);
        const now = new Date().toISOString(), activityId = crypto.randomUUID();
        let sourceId = "";
        if (sourceUrl) {
          sourceId = crypto.randomUUID();
          await env.DB.prepare(`INSERT INTO sales_company_research_notes (id,company_id,note,source_url,source_title,confidence,created_by,created_at)
            VALUES (?,?,?,?,?,?,?,?)`).bind(sourceId, companyId, note, sourceUrl, salesString(body.title, "Research note evidence", 160), confidence, actor.ownerId, now).run();
        } else {
          await env.DB.prepare(`INSERT INTO sales_company_research_notes (id,company_id,note,confidence,created_by,created_at)
            VALUES (?,?,?,'unverified',?,?)`).bind(activityId, companyId, note, actor.ownerId, now).run();
        }
        await auditCrm(env, actor, "crm_research_note_added", "company", companyId, { note_id: sourceId || activityId, source_id: sourceId || null });
        return json({ id: sourceId || activityId, company_id: companyId, source_id: sourceId || null, created_at: now }, 201);
      });
    }
    if (path === "/v1/crm/research-notes" && method === "GET") {
      const denied = requireScope("research:read"); if (denied) return denied;
      const companyId = salesString(url.searchParams.get("company_id"), "", 80);
      if (!companyId) return json({ error: "company_id is required." }, 400);
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
      const company = await env.DB.prepare("SELECT id FROM sales_companies WHERE id=?").bind(companyId).all();
      if (!company.results?.length) return json({ error: "Company not found." }, 404);
      const notes = await env.DB.prepare(`SELECT n.id,n.company_id,c.name AS company_name,n.note,n.source_url,
        n.source_title,n.confidence,n.created_by,n.created_at
        FROM sales_company_research_notes n JOIN sales_companies c ON c.id=n.company_id
        WHERE n.company_id=? ORDER BY n.created_at DESC LIMIT ?`).bind(companyId, limit).all();
      return json({ notes: notes.results ?? [] });
    }
    if (path === "/v1/crm/communications" && method === "GET") {
      const denied = requireScope("communications:read"); if (denied) return denied;
      const companyId = salesString(url.searchParams.get("company_id"), "", 80);
      const contactId = salesString(url.searchParams.get("contact_id"), "", 80);
      if (!companyId && !contactId) return json({ error: "company_id or contact_id is required." }, 400);
      let gmail;
      if (companyId) gmail = await env.DB.prepare(`SELECT id,provider,gmail_message_id AS message_id,gmail_thread_id AS thread_id,gmail_draft_id AS draft_id,direction,from_email,to_emails_json,cc_emails_json,subject,snippet,occurred_at
        FROM sales_communications WHERE company_id=? AND deleted_at IS NULL ORDER BY occurred_at DESC LIMIT 200`).bind(companyId).all();
      else gmail = await env.DB.prepare(`SELECT c.id,c.provider,c.gmail_message_id AS message_id,c.gmail_thread_id AS thread_id,c.gmail_draft_id AS draft_id,c.direction,c.from_email,c.to_emails_json,c.cc_emails_json,c.subject,c.snippet,c.occurred_at
        FROM sales_communications c WHERE c.contact_id=? AND c.deleted_at IS NULL ORDER BY c.occurred_at DESC LIMIT 200`).bind(contactId).all();
      let resend: { results?: Record<string, unknown>[] } = { results: [] };
      if (companyId) resend = await env.DB.prepare(`SELECT o.id,'resend' AS provider,o.provider_id AS message_id,'' AS thread_id,'' AS draft_id,'sent' AS direction,'' AS from_email,json_array(o.recipient) AS to_emails_json,'[]' AS cc_emails_json,o.subject,o.body AS snippet,o.sent_at AS occurred_at
        FROM outreach_log o JOIN sales_record_companies rc ON rc.record_id=o.lead_id
        WHERE rc.company_id=? ORDER BY o.sent_at DESC LIMIT 200`).bind(companyId).all<Record<string, unknown>>();
      else resend = await env.DB.prepare(`SELECT o.id,'resend' AS provider,o.provider_id AS message_id,'' AS thread_id,'' AS draft_id,'sent' AS direction,'' AS from_email,json_array(o.recipient) AS to_emails_json,'[]' AS cc_emails_json,o.subject,o.body AS snippet,o.sent_at AS occurred_at
        FROM outreach_log o JOIN sales_contact_emails e ON lower(e.normalized_email)=lower(o.recipient)
        WHERE e.contact_id=? ORDER BY o.sent_at DESC LIMIT 200`).bind(contactId).all<Record<string, unknown>>();
      const communications = [...(gmail.results ?? []), ...(resend.results ?? [])].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 200);
      return json({ communications, sources: ["gmail", "resend"], note: "Gmail message status is authoritative for Gmail messages; Resend entries remain separate and are not converted into Gmail send events." });
    }
    if (path === "/v1/crm/opportunities" && method === "GET") {
      const denied = requireScope("opportunities:read"); if (denied) return denied;
      const rows = await env.DB.prepare(`SELECT r.id,r.name AS company_name,r.stage,r.industry,r.status,r.monthly_revenue,r.total_value,r.probability,r.next_follow_up,r.last_contact,r.updated_at,rc.company_id
        FROM sales_records r LEFT JOIN sales_record_companies rc ON rc.record_id=r.id WHERE r.entity_type='lead' ORDER BY r.updated_at DESC LIMIT 1000`).all();
      return json({ opportunities: rows.results ?? [], model: "sales_records" });
    }
    const opportunityMatch = path.match(/^\/v1\/crm\/opportunities\/([\w-]+)$/);
    if (opportunityMatch && (method === "GET" || method === "PATCH")) {
      const denied = requireScope(method === "GET" ? "opportunities:read" : "opportunities:write"); if (denied) return denied;
      if (method === "GET") {
        const rows = await env.DB.prepare(`SELECT r.id,r.name AS company_name,r.stage,r.industry,r.status,r.monthly_revenue,r.total_value,r.probability,r.next_follow_up,r.last_contact,r.data_json,r.updated_at,rc.company_id
          FROM sales_records r LEFT JOIN sales_record_companies rc ON rc.record_id=r.id WHERE r.id=? AND r.entity_type='lead'`).bind(opportunityMatch[1]).all();
        return rows.results?.length ? json({ opportunity: rows.results[0] }) : json({ error: "Opportunity not found." }, 404);
      }
      return idempotentCrmWrite(request, env, actor, path, async (patch) => {
        const old = await env.DB.prepare("SELECT * FROM sales_records WHERE id=? AND entity_type='lead'").bind(opportunityMatch[1]).all<Record<string, unknown>>();
        const row = old.results?.[0]; if (!row) return json({ error: "Opportunity not found." }, 404);
        const allowed = new Set(["stage", "status", "monthly_revenue", "total_value", "probability", "next_follow_up", "notes", "pipeline_outcome", "win_loss_reason"]);
        const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
        if (unknown.length) return json({ error: `Unsupported opportunity fields: ${unknown.join(", ")}` }, 400);
        let data: Record<string, unknown> = {}; try { data = JSON.parse(String(row.data_json || "{}")); } catch { data = {}; }
        const next = { ...data, ...patch }, stage = salesString(next.stage, String(row.stage), 40);
        if (!SALES_STAGES.has(stage)) return json({ error: "Unknown lead stage" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE sales_records SET stage=?,status=?,monthly_revenue=?,total_value=?,probability=?,next_follow_up=?,data_json=?,updated_at=? WHERE id=?`)
          .bind(stage, salesString(next.status, String(row.status), 30), salesNumber(next.monthly_revenue, Number(row.monthly_revenue)), salesNumber(next.total_value, Number(row.total_value)), Math.min(100, Math.round(salesNumber(next.probability, Number(row.probability)))), salesDate(next.next_follow_up), JSON.stringify(next), now, opportunityMatch[1]).run();
        await auditCrm(env, actor, "crm_opportunity_updated", "lead", opportunityMatch[1], { changed_fields: Object.keys(patch) });
        return json({ id: opportunityMatch[1], stage, updated_at: now });
      });
    }
    if (path === "/v1/crm/follow-up-tasks" && method === "GET") {
      const denied = requireScope("tasks:read"); if (denied) return denied;
      const rows = await env.DB.prepare(`SELECT t.*,co.name AS company_name,r.name AS opportunity_name,c.display_name AS contact_name
        FROM sales_follow_up_tasks t JOIN sales_companies co ON co.id=t.company_id
        LEFT JOIN sales_records r ON r.id=t.record_id
        LEFT JOIN sales_contacts c ON c.id=t.contact_id
        WHERE (?='' OR t.status=?) ORDER BY t.due_at LIMIT 500`).bind(salesString(url.searchParams.get("status"), "", 20), salesString(url.searchParams.get("status"), "", 20)).all();
      return json({ tasks: rows.results ?? [] });
    }
    if (path === "/v1/crm/follow-up-tasks" && method === "POST") {
      const denied = requireScope("tasks:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (body) => {
        const companyId = salesString(body.company_id, "", 80), recordId = salesString(body.record_id, "", 80), title = salesString(body.title, "", 240);
        if (!companyId || !title) return json({ error: "company_id and title are required." }, 400);
        const company = await env.DB.prepare("SELECT id FROM sales_companies WHERE id=?").bind(companyId).all();
        if (!company.results?.length) return json({ error: "Company not found." }, 404);
        if (recordId) {
          const linkedRecord = await env.DB.prepare("SELECT record_id FROM sales_record_companies WHERE record_id=? AND company_id=?").bind(recordId, companyId).all();
          if (!linkedRecord.results?.length) return json({ error: "record_id is not linked to the selected company." }, 400);
        }
        const contactId = salesString(body.contact_id, "", 80);
        if (contactId) {
          const linked = await env.DB.prepare("SELECT contact_id FROM sales_company_contacts WHERE company_id=? AND contact_id=?").bind(companyId, contactId).all();
          if (!linked.results?.length) return json({ error: "Contact is not linked to the selected company." }, 400);
        }
        const dueAt = salesDate(body.due_at);
        if (!dueAt) return json({ error: "due_at is required and must use YYYY-MM-DD." }, 400);
        const dedupeKey = salesString(body.dedupe_key, "", 300) || null;
        const id = crypto.randomUUID(), now = new Date().toISOString();
        try {
          await env.DB.prepare(`INSERT INTO sales_follow_up_tasks (id,company_id,record_id,contact_id,task_type,title,notes,assigned_to,due_at,status,generated_by,dedupe_key,created_by,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'open','manual',?,?,?,?)`).bind(id, companyId, recordId || null, contactId || null, salesString(body.task_type, "follow_up", 60), title, salesString(body.notes, "", 2000), salesString(body.assigned_to, "", 80), dueAt, dedupeKey, actor.ownerId, now, now).run();
        } catch (error) {
          if (dedupeKey) {
            const prior = await env.DB.prepare("SELECT id FROM sales_follow_up_tasks WHERE dedupe_key=?").bind(dedupeKey).all<Record<string, unknown>>();
            if (prior.results?.length) return json({ id: prior.results[0].id, matched_existing: true }, 200);
          }
          throw error;
        }
        await auditCrm(env, actor, "crm_follow_up_task_created", "follow_up_task", id, { company_id: companyId, record_id: recordId || null, contact_id: contactId || null, due_at: dueAt });
        return json({ id, status: "open", created_at: now }, 201);
      });
    }
    const taskMatch = path.match(/^\/v1\/crm\/follow-up-tasks\/([\w-]+)$/);
    if (taskMatch && method === "PATCH") {
      const denied = requireScope("tasks:write"); if (denied) return denied;
      return idempotentCrmWrite(request, env, actor, path, async (patch) => {
        const rowResult = await env.DB.prepare("SELECT * FROM sales_follow_up_tasks WHERE id=?").bind(taskMatch[1]).all<Record<string, unknown>>();
        const row = rowResult.results?.[0]; if (!row) return json({ error: "Follow-up task not found." }, 404);
        const allowed = new Set(["title", "notes", "assigned_to", "due_at", "status"]);
        const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
        if (unknown.length) return json({ error: `Unsupported task fields: ${unknown.join(", ")}` }, 400);
        const status = salesString(patch.status, String(row.status), 20);
        if (!["open", "completed", "cancelled"].includes(status)) return json({ error: "status must be open, completed, or cancelled." }, 400);
        const dueAt = Object.prototype.hasOwnProperty.call(patch, "due_at") ? salesDate(patch.due_at) : String(row.due_at);
        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE sales_follow_up_tasks SET title=?,notes=?,assigned_to=?,due_at=?,status=?,updated_at=?,completed_at=?,cancelled_at=? WHERE id=?`)
          .bind(salesString(patch.title, String(row.title), 240), salesString(patch.notes, String(row.notes), 2000), salesString(patch.assigned_to, String(row.assigned_to), 80), dueAt,
            status, now, status === "completed" ? now : status === "open" ? null : row.completed_at, status === "cancelled" ? now : status === "open" ? null : row.cancelled_at, taskMatch[1]).run();
        await auditCrm(env, actor, "crm_follow_up_task_updated", "follow_up_task", taskMatch[1], { changed_fields: Object.keys(patch), status });
        return json({ id: taskMatch[1], status, updated_at: now });
      });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message.slice(0, 240) : "CRM request failed" }, 400);
  }
}

function originMatches(request: Request, env: Env): boolean {
  return Boolean(env.PUBLIC_READ_ORIGIN && request.headers.get("Origin") === env.PUBLIC_READ_ORIGIN);
}

function salesCors(request: Request, env: Env): HeadersInit {
  return originMatches(request, env) ? {
    "Access-Control-Allow-Origin": env.PUBLIC_READ_ORIGIN!,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  } : {};
}

function salesObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(record).length > 30_000) throw new Error("record must be under 30 KB");
  return record;
}

function salesString(value: unknown, fallback = "", max = 200): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max) || fallback;
}

function salesNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100_000_000) : fallback;
}

function salesDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return dateOnly(value, "date");
}

async function salesRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: salesCors(request, env) });
  const actor = identifyActor(request, env);
  if (!actor) return json({ error: "Unauthorized. Use your individual Partnerships access token." }, 401, salesCors(request, env));
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (path === "/v1/sales/session" && request.method === "GET") {
      const user = await env.DB.prepare("SELECT display_name, role, active FROM sales_users WHERE id = ?").bind(actor.id).all<Record<string, unknown>>();
      if (!actor.legacy && Number(user.results?.[0]?.active) !== 1) return json({ error: "This user is inactive. Contact the workspace owner." }, 403, salesCors(request, env));
      const row = user.results?.[0];
      return json({ user: { id: actor.id, name: String(row?.display_name || actor.display_name), role: String(row?.role || actor.role), legacy: actor.legacy } }, 200, salesCors(request, env));
    }
    if (!actor.legacy) {
      const user = await env.DB.prepare("SELECT active FROM sales_users WHERE id = ?").bind(actor.id).all<Record<string, unknown>>();
      if (Number(user.results?.[0]?.active) !== 1) return json({ error: "This user is inactive. Contact the workspace owner." }, 403, salesCors(request, env));
    }
    if (path.startsWith("/v1/sales/gmail/")) {
      return handleGmailRoute(request, env, url, actor, salesCors(request, env));
    }
    if (path === "/v1/sales/audit" && request.method === "GET") {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 30)));
      const rows = await env.DB.prepare("SELECT a.*, u.display_name FROM sales_audit_log a LEFT JOIN sales_users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ?").bind(limit).all();
      return json({ entries: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/suppressions" && request.method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM sales_suppressions ORDER BY created_at DESC LIMIT 500").all();
      return json({ suppressions: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/suppressions" && request.method === "POST") {
      const body = salesObject(await request.json()), type = salesString(body.match_type, "email", 20), value = salesString(body.value, "", 254).toLowerCase(), reason = salesString(body.reason, "opt-out", 300);
      if (!["email", "domain"].includes(type) || !value || (type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) return json({ error: "Provide a valid email address or domain." }, 400, salesCors(request, env));
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO sales_suppressions (id, match_type, value, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(match_type, value) DO UPDATE SET reason=excluded.reason, created_by=excluded.created_by")
        .bind(crypto.randomUUID(), type, value, reason, actor.id, now).run();
      await audit(env, actor, "suppression_added", "suppression", value, { match_type: type, reason });
      return json({ saved: true }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/relationships" && request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT rel.*, a.name AS agency_name, b.name AS brand_name FROM sales_record_relationships rel
        JOIN sales_records a ON a.id=rel.from_record_id JOIN sales_records b ON b.id=rel.to_record_id
        ORDER BY rel.created_at DESC LIMIT 500`).all();
      return json({ relationships: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/research-sources" && request.method === "GET") {
      const recordId = salesString(url.searchParams.get("record_id"), "", 80);
      if (!recordId) return json({ error: "record_id is required" }, 400, salesCors(request, env));
      const rows = await env.DB.prepare("SELECT * FROM sales_research_sources WHERE record_id=? ORDER BY captured_at DESC LIMIT 100").bind(recordId).all();
      return json({ sources: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/research-sources" && request.method === "POST") {
      const body = salesObject(await request.json()), recordId = salesString(body.record_id, "", 80), title = salesString(body.title, "", 160), sourceUrl = salesString(body.url, "", 1000);
      if (!recordId || !title || !/^https:\/\//i.test(sourceUrl)) return json({ error: "record_id, source title, and an HTTPS source URL are required." }, 400, salesCors(request, env));
      const record = await env.DB.prepare("SELECT id FROM sales_records WHERE id=?").bind(recordId).all();
      if (!record.results?.length) return json({ error: "Record not found." }, 404, salesCors(request, env));
      const confidence = salesString(body.confidence, "unverified", 20).toLowerCase();
      if (!["unverified","low","medium","high"].includes(confidence)) return json({ error: "confidence must be unverified, low, medium, or high." }, 400, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO sales_research_sources (id, record_id, source_type, title, url, fact_summary, confidence, captured_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, recordId, salesString(body.source_type, "public_web", 40), title, sourceUrl, salesString(body.fact_summary, "", 1000), confidence, now, actor.id).run();
      await audit(env, actor, "research_source_added", "sales_record", recordId, { source_id: id, title, url: sourceUrl, confidence });
      return json({ id, captured_at: now }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/agent-settings" && request.method === "GET") {
      const rows = await env.DB.prepare("SELECT setting_key, value_json, updated_at, updated_by FROM sales_agent_settings ORDER BY setting_key").all<Record<string, unknown>>();
      return json({ settings: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/agent-settings" && request.method === "PATCH") {
      const body = salesObject(await request.json());
      const targets = salesObject(body.weekly_targets);
      const normalized: Record<string, { min: number; max: number }> = {};
      for (const key of ["discovered", "qualified", "outreach_drafts"]) {
        const target = salesObject(targets[key]);
        const min = Math.round(salesNumber(target.min, -1)), max = Math.round(salesNumber(target.max, -1));
        if (min < 0 || max < min || max > 500) return json({ error: `weekly_targets.${key} must have a valid minimum and maximum (0–500).` }, 400, salesCors(request, env));
        normalized[key] = { min, max };
      }
      const monthlyLimit = Number(body.monthly_cost_limit_usd);
      if (!Number.isFinite(monthlyLimit) || monthlyLimit < 0 || monthlyLimit > 50) return json({ error: "monthly_cost_limit_usd must be between $0 and $50." }, 400, salesCors(request, env));
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO sales_agent_settings (setting_key,value_json,updated_by,updated_at) VALUES ('weekly_targets',?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(JSON.stringify(normalized), actor.id, now).run();
      await env.DB.prepare("INSERT INTO sales_agent_settings (setting_key,value_json,updated_by,updated_at) VALUES ('monthly_cost_limit_usd',?,?,?) ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at").bind(JSON.stringify(monthlyLimit), actor.id, now).run();
      await audit(env, actor, "agent_settings_updated", "agent_settings", "weekly_targets", { weekly_targets: normalized, monthly_cost_limit_usd: monthlyLimit });
      return json({ saved: true, updated_at: now }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/relationships" && request.method === "POST") {
      const body = salesObject(await request.json()), agencyId = salesString(body.agency_id, "", 80), brandId = salesString(body.brand_id, "", 80), evidenceUrl = salesString(body.evidence_url, "", 1000);
      if (!agencyId || !brandId || agencyId === brandId) return json({ error: "Select two different records: an agency and a represented brand." }, 400, salesCors(request, env));
      if (!/^https:\/\//i.test(evidenceUrl)) return json({ error: "Provide an HTTPS source documenting the agency-to-brand relationship." }, 400, salesCors(request, env));
      const pair = await env.DB.prepare("SELECT id, data_json FROM sales_records WHERE id IN (?, ?)").bind(agencyId, brandId).all<Record<string, unknown>>();
      if (pair.results?.length !== 2) return json({ error: "Agency or brand record was not found." }, 404, salesCors(request, env));
      const agency = pair.results.find((row) => row.id === agencyId);
      let agencyData: Record<string, unknown> = {};
      try { agencyData = JSON.parse(String(agency?.data_json || "{}")); } catch { agencyData = {}; }
      if (String(agencyData.lead_category || "brand").toLowerCase() !== "agency") return json({ error: "Mark the agency record's Lead Category as Agency before linking represented brands." }, 400, salesCors(request, env));
      const existing = await env.DB.prepare("SELECT id FROM sales_record_relationships WHERE from_record_id=? AND to_record_id=? AND relationship_type='represents' LIMIT 1").bind(agencyId, brandId).all();
      if (existing.results?.length) return json({ error: "This agency-to-brand relationship is already recorded." }, 409, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString(), sourceId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO sales_research_sources (id, record_id, source_type, title, url, fact_summary, confidence, captured_at, added_by) VALUES (?, ?, 'agency_relationship', 'Agency relationship evidence', ?, 'Source supplied to document this represented-brand relationship; verify before acting.', 'unverified', ?, ?)")
        .bind(sourceId, agencyId, evidenceUrl, now, actor.id).run();
      await env.DB.prepare("INSERT INTO sales_record_relationships (id, from_record_id, to_record_id, relationship_type, evidence_source_id, created_by, created_at) VALUES (?, ?, ?, 'represents', ?, ?, ?) ON CONFLICT(from_record_id,to_record_id,relationship_type) DO NOTHING")
        .bind(id, agencyId, brandId, sourceId, actor.id, now).run();
      await audit(env, actor, "agency_brand_relationship_added", "sales_record_relationship", id, { agency_id: agencyId, brand_id: brandId, evidence_source_id: sourceId || null });
      return json({ id, saved: true }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/revenue" && request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT e.*, r.name AS client_name FROM revenue_entries e JOIN sales_records r ON r.id=e.client_id ORDER BY e.month DESC, r.name LIMIT 240`).all();
      return json({ entries: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/revenue" && request.method === "POST") {
      const body = salesObject(await request.json()), clientId = salesString(body.client_id, "", 80), month = salesString(body.month, "", 7);
      if (!clientId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "client_id and month (YYYY-MM) are required" }, 400, salesCors(request, env));
      const amount = salesNumber(body.amount, -1); if (amount < 0) return json({ error: "amount must be zero or greater" }, 400, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO revenue_entries (id, client_id, month, amount, entry_type, reference, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, clientId, month, amount, ["received", "contracted", "adjustment"].includes(String(body.entry_type)) ? body.entry_type : "received", salesString(body.reference, "", 160), salesString(body.notes, "", 1000), now).run();
      await audit(env, actor, "revenue_logged", "revenue_entry", id, { client_id: clientId, month, amount });
      return json({ id, created_at: now }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/deliverables" && request.method === "GET") {
      const month = url.searchParams.get("month") || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "month must use YYYY-MM" }, 400, salesCors(request, env));
      const rows = await env.DB.prepare(`SELECT d.*, r.name AS client_name, COALESCE(m.completed_units,0) AS completed_units, m.completed_at, m.published_url, m.notes AS completion_notes FROM deliverable_definitions d JOIN sales_records r ON r.id=d.client_id LEFT JOIN deliverable_monthly m ON m.definition_id=d.id AND m.month=? WHERE d.active=1 ORDER BY r.name, d.name`).bind(month).all();
      return json({ month, deliverables: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/deliverables/definitions" && request.method === "POST") {
      const body = salesObject(await request.json()), clientId = salesString(body.client_id, "", 80), name = salesString(body.name, "", 160);
      if (!clientId || !name) return json({ error: "client_id and name are required" }, 400, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO deliverable_definitions (id, client_id, name, monthly_commitment, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, clientId, name, Math.round(salesNumber(body.monthly_commitment, 1)), salesString(body.notes, "", 1000), now).run();
      await audit(env, actor, "deliverable_created", "deliverable", id, { client_id: clientId, name });
      return json({ id }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/deliverables/completions" && request.method === "POST") {
      const body = salesObject(await request.json()), definitionId = salesString(body.definition_id, "", 80), month = salesString(body.month, "", 7);
      if (!definitionId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "definition_id and month (YYYY-MM) are required" }, 400, salesCors(request, env));
      const units = Math.round(salesNumber(body.completed_units)); if (units < 0) return json({ error: "completed_units must be zero or greater" }, 400, salesCors(request, env));
      const now = new Date().toISOString();
      const hasPublishedUrl = Object.prototype.hasOwnProperty.call(body, "published_url");
      await env.DB.prepare(`INSERT INTO deliverable_monthly (id, definition_id, month, completed_units, completed_at, published_url, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(definition_id, month) DO UPDATE SET completed_units=excluded.completed_units, completed_at=excluded.completed_at, published_url=CASE WHEN ? THEN excluded.published_url ELSE deliverable_monthly.published_url END, notes=excluded.notes, updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(), definitionId, month, units, units ? now : null, salesString(body.published_url, "", 500), salesString(body.notes, "", 1000), now, hasPublishedUrl ? 1 : 0).run();
      await audit(env, actor, "deliverable_completion_updated", "deliverable", definitionId, { month, completed_units: units });
      return json({ saved: true, updated_at: now }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/discovery" && request.method === "GET") {
      const query = salesString(url.searchParams.get("q"), "Minnesota brands sponsorship partnerships sports", 180);
      const rssUrl = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
      const response = await fetch(rssUrl, { headers: { "User-Agent": "10KHubPartnershipResearch/1.0" } });
      if (!response.ok) throw new Error("News search source returned HTTP " + response.status);
      const xml = await response.text();
      const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 25).map((m) => {
        const tag = (name: string) => decode(m[1].match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        return { title: tag("title"), url: tag("link"), published_at: tag("pubDate"), source: tag("source") };
      }).filter((x) => x.title && /^https:\/\//.test(x.url));
      return json({ query, source: "Google News RSS", disclaimer: "Search results are leads for human review. They do not verify sponsorship fit, budgets, contacts, or buying intent.", items }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/assist" && request.method === "POST") {
      const body = salesObject(await request.json()), task = salesString(body.task, "advice", 30), context = salesString(body.context, "", 6000);
      if (!context) return json({ error: "Provide CRM facts to analyze" }, 400, salesCors(request, env));
      if (task === "contact_roles") {
        let lead: Record<string, unknown> = {};
        try { lead = salesObject(JSON.parse(context)); } catch { lead = {}; }
        const company = salesString(lead.company, "This company", 160);
        const industry = salesString(lead.industry, "", 100);
        const description = salesString(lead.description, "", 1000);
        const campaign = salesString(lead.campaign_ideas, "", 1000);
        const isAutomotiveDealer = /dealership|automotive|ford|auto dealer|car dealer/i.test(`${industry} ${description}`);
        const roleSuggestions = isAutomotiveDealer
          ? [
              { title: "Marketing Manager or Marketing Director", why_relevant: "A common role to check for someone who manages advertising and local campaigns.", public_search_terms: `"${company}" marketing manager` },
              { title: "Local or Regional Marketing Manager", why_relevant: "A possible role to check when dealership or regional marketing is relevant; verify whether it exists.", public_search_terms: `"${company}" regional marketing` },
              { title: "Dealer Principal or General Manager", why_relevant: "A possible senior contact for dealership-level partnership decisions; verify their responsibilities.", public_search_terms: `"${company}" dealer principal OR general manager` },
              { title: "Partnerships or Sponsorship Manager", why_relevant: "A title to check for people who handle sponsorships, if the organization has that function.", public_search_terms: `"${company}" sponsorship OR partnerships` },
            ]
          : [
              { title: "Marketing Manager or Marketing Director", why_relevant: "A common role to check for someone who manages advertising and campaigns.", public_search_terms: `"${company}" marketing manager` },
              { title: "Brand Partnerships or Sponsorship Manager", why_relevant: "A title to check for someone who handles media partnerships, if the organization has that function.", public_search_terms: `"${company}" partnerships OR sponsorship` },
              { title: "Regional Marketing Manager", why_relevant: "A possible role when regional campaigns are relevant; verify whether it exists.", public_search_terms: `"${company}" regional marketing` },
            ];
        const evidence = [
          industry ? { field: "Industry", text: industry } : null,
          description ? { field: "Company description", text: description } : null,
          campaign ? { field: "Campaign ideas", text: campaign } : null,
        ].filter(Boolean);
        return json({ result: { summary: `Generic job titles to look for at ${company}. No employees or job titles were searched or verified.`, suggested_roles: roleSuggestions, evidence, next_steps: ["Search the company’s official website and professional profiles using the suggested terms.", "Confirm the person’s current title and responsibilities from a reliable public source before outreach."], assumptions: ["These titles may not exist at this company.", "The lead record does not establish who approves marketing or sponsorship decisions."] }, model: "rule_based_role_suggestions", disclaimer: "Generic title suggestions based on CRM fields only. No live web research or person/contact verification was performed." }, 200, salesCors(request, env));
      }
      if (!env.AI) return json({ error: "AI is not enabled on this Worker. Configure the optional Cloudflare Workers AI binding, deploy it, then retry." }, 503, salesCors(request, env));
      const prompt = `You are a cautious sponsorship sales assistant for 10K Takes, a Minnesota sports media business. Return only valid JSON, without Markdown fences, with keys: summary (string), score (integer 0-100 or null), score_breakdown (array of {criterion,points,max,evidence}), confidence (low, medium, or high), evidence (array), next_steps (array), assumptions (array), draft (string). Task: ${task}. Use only facts in the supplied context. Do not infer facts from a company name or invent contacts, budgets, audience metrics, or deal terms. Mark uncertainty and keep all advice as a draft for human review. If task is score, give an editorial fit ranking (not a probability of winning) using: brand/audience fit 0-30, Minnesota relevance 0-20, documented sponsorship or marketing activity 0-20, activation fit for 10K Takes 0-15, and verified contactability 0-15. Award points only when supported by context; missing evidence receives zero points and must be named as a data gap, not treated as proof of poor fit. Return null only if the context contains no usable company or fit information beyond the company name. For other tasks, score may be null. Context: ${context}`;
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages: [{ role: "user", content: prompt }], max_tokens: 700 });
      return json({ result, model: "@cf/meta/llama-3.1-8b-instruct-fast", disclaimer: "AI output is a draft based only on supplied facts; review before using." }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/outreach" && request.method === "POST") {
      const body = salesObject(await request.json());
      if (body.confirm_send !== true) return json({ error: "Email is sent only after an explicit confirm_send approval." }, 400, salesCors(request, env));
      if (actor.legacy) return json({ error: "Email sending requires an individual Jack or Cody access token. Reconnect with your named-user token." }, 403, salesCors(request, env));
      if (!env.RESEND_API_KEY || !env.RESEND_FROM) return json({ error: "Email sending is not configured. Add RESEND_API_KEY and RESEND_FROM Worker secrets after verifying the sender domain." }, 503, salesCors(request, env));
      const recipient = salesString(body.to, "", 254), subject = salesString(body.subject, "", 200), content = salesString(body.body, "", 10000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || !subject || !content) return json({ error: "A valid recipient, subject, and message body are required." }, 400, salesCors(request, env));
      const normalizedRecipient = recipient.toLowerCase();
      const suppression = await env.DB.prepare("SELECT id FROM sales_suppressions WHERE (match_type='email' AND value=?) OR (match_type='domain' AND value=?) LIMIT 1").bind(normalizedRecipient, normalizedRecipient.split("@")[1] || "").all();
      if (suppression.results?.length) { await audit(env, actor, "outreach_blocked_suppressed", "outreach", "", { recipient: normalizedRecipient }); return json({ error: "This recipient is on the suppression list. No email was sent." }, 409, salesCors(request, env)); }
      const leadId = salesString(body.lead_id, "", 80);
      if (!leadId) return json({ error: "Select a lead record before sending so the outreach can be checked and audited." }, 400, salesCors(request, env));
      const leadRows = await env.DB.prepare("SELECT id, entity_type, name, data_json FROM sales_records WHERE id=?").bind(leadId).all<Record<string, unknown>>();
      const lead = leadRows.results?.[0];
      if (!lead || lead.entity_type !== "lead") return json({ error: "Outreach can only be sent for a lead record." }, 400, salesCors(request, env));
      let leadData: Record<string, unknown> = {};
      try { leadData = JSON.parse(String(lead.data_json || "{}")); } catch { leadData = {}; }
      const contactEmail = typeof leadData.contact_email === "string" ? leadData.contact_email.toLowerCase() : "";
      const contactEvidenceUrl = typeof leadData.contact_source_url === "string" ? leadData.contact_source_url : "";
      if (!contactEmail || contactEmail !== normalizedRecipient || !/^https:\/\//i.test(contactEvidenceUrl)) {
        await audit(env, actor, "outreach_blocked_missing_contact_evidence", "lead", leadId, { recipient: normalizedRecipient });
        return json({ error: "Add the recipient to this lead and provide an HTTPS Contact Source URL before sending." }, 409, salesCors(request, env));
      }
      const clients = await env.DB.prepare("SELECT name, data_json FROM sales_records WHERE entity_type='client'").all<Record<string, unknown>>();
      const leadName = String(lead.name || "").trim().toLowerCase();
      const isExistingClient = (clients.results ?? []).some((row) => { try { const d = JSON.parse(String(row.data_json || "{}")); const sameCompany = String(row.name || "").trim().toLowerCase() === leadName; return sameCompany || [d.contact_email, ...(Array.isArray(d.additional_contacts) ? d.additional_contacts.map((c: Record<string, unknown>) => c.email) : [])].some((email) => typeof email === "string" && email.toLowerCase() === normalizedRecipient); } catch { return false; } });
      if (isExistingClient) { await audit(env, actor, "outreach_blocked_existing_client", "outreach", "", { recipient: normalizedRecipient }); return json({ error: "This address belongs to an existing client. Outreach was not sent." }, 409, salesCors(request, env)); }
      const recent = await env.DB.prepare("SELECT id FROM outreach_log WHERE (lower(recipient)=? OR lead_id=?) AND sent_at >= ? LIMIT 1").bind(normalizedRecipient, leadId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).all();
      if (recent.results?.length) { await audit(env, actor, "outreach_blocked_duplicate_window", "outreach", "", { recipient: normalizedRecipient }); return json({ error: "An email was already sent to this address in the last 24 hours. Duplicate send blocked." }, 409, salesCors(request, env)); }
      const lockedAt = new Date().toISOString(), cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const guard = await env.DB.prepare(`INSERT INTO outreach_send_guards (recipient, locked_at) VALUES (?, ?)
        ON CONFLICT(recipient) DO UPDATE SET locked_at=excluded.locked_at WHERE outreach_send_guards.locked_at <= ? RETURNING recipient`).bind(normalizedRecipient, lockedAt, cutoff).all();
      if (!guard.results?.length) { await audit(env, actor, "outreach_blocked_duplicate_window", "outreach", "", { recipient: normalizedRecipient }); return json({ error: "An email was already sent to this address in the last 24 hours. Duplicate send blocked." }, 409, salesCors(request, env)); }
      let sent: Response;
      let result: Record<string, unknown>;
      try {
        sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.RESEND_FROM, to: [recipient], subject, text: content }) });
        result = await sent.json() as Record<string, unknown>;
      } catch (error) {
        await env.DB.prepare("DELETE FROM outreach_send_guards WHERE recipient=? AND locked_at=?").bind(normalizedRecipient, lockedAt).run();
        throw error;
      }
      if (!sent.ok) {
        await env.DB.prepare("DELETE FROM outreach_send_guards WHERE recipient=? AND locked_at=?").bind(normalizedRecipient, lockedAt).run();
        return json({ error: "Email provider rejected the request", details: result }, sent.status, salesCors(request, env));
      }
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO outreach_log (id, lead_id, recipient, subject, body, provider_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), leadId || null, recipient, subject, content, salesString(result.id, "", 160), now).run();
      await audit(env, actor, "outreach_sent", "lead", leadId, { recipient: normalizedRecipient, subject, provider_id: salesString(result.id, "", 160) });
      if (leadId) await env.DB.prepare("INSERT INTO sales_activities (id, record_id, activity_type, summary, occurred_at, created_at) VALUES (?, ?, 'email_sent', ?, ?, ?)").bind(crypto.randomUUID(), leadId, `Approved email sent to ${recipient}: ${subject}`, now, now).run();
      return json({ sent: true, provider_id: result.id, sent_at: now }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/records" && request.method === "GET") {
      const type = url.searchParams.get("type");
      if (type && !SALES_TYPES.has(type)) return json({ error: "Unknown record type" }, 400, salesCors(request, env));
      const query = type
        ? await env.DB.prepare("SELECT * FROM sales_records WHERE entity_type = ? ORDER BY updated_at DESC LIMIT 1000").bind(type).all()
        : await env.DB.prepare("SELECT * FROM sales_records ORDER BY updated_at DESC LIMIT 2000").all();
      const rows = (query.results ?? []).map((row) => {
        let data: unknown = {};
        try { data = JSON.parse(String((row as Record<string, unknown>).data_json || "{}")); } catch { data = {}; }
        return { ...(row as Record<string, unknown>), data };
      });
      return json({ records: rows }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/records" && request.method === "POST") {
      const body = salesObject(await request.json());
      const type = salesString(body.entity_type, "", 20);
      if (!SALES_TYPES.has(type)) return json({ error: "entity_type must be client, lead, or prospect" }, 400, salesCors(request, env));
      const data = salesObject(body.data);
      const name = salesString(data.company_name ?? data.name, "", 160);
      if (!name) return json({ error: "company_name is required" }, 400, salesCors(request, env));
      const duplicate = await env.DB.prepare("SELECT id FROM sales_records WHERE entity_type = ? AND lower(name) = lower(?) LIMIT 1").bind(type, name).all();
      if (duplicate.results?.length) return json({ error: "A record with that company name already exists in this category" }, 409, salesCors(request, env));
      const stage = salesString(data.stage, type === "lead" ? "New" : "", 40);
      if (type === "lead" && !SALES_STAGES.has(stage)) return json({ error: "Unknown lead stage" }, 400, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO sales_records (id, entity_type, name, stage, industry, status, monthly_revenue, total_value, probability, next_follow_up, contract_end, last_contact, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, type, name, stage, salesString(data.industry, "", 100), salesString(data.status, type === "client" ? "active" : "open", 30),
          salesNumber(data.monthly_revenue ?? data.estimated_monthly_value), salesNumber(data.total_value ?? data.estimated_total_value),
          Math.min(100, Math.round(salesNumber(data.probability))), salesDate(data.next_follow_up), salesDate(data.contract_end ?? data.contract_expiration_date),
          salesDate(data.last_contact), JSON.stringify(data), now, now).run();
      await audit(env, actor, "record_created", type, id, { name, stage, category: salesString(data.lead_category, "brand", 40) });
      if (data.source_url && typeof data.source_url === "string") await env.DB.prepare("INSERT INTO sales_research_sources (id, record_id, source_type, title, url, fact_summary, confidence, captured_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, salesString(data.source_type, "public_web", 40), salesString(data.source_name, "Research source", 160), salesString(data.source_url, "", 1000), salesString(data.company_description, "", 1000), ["high","medium","low"].includes(salesString(data.research_confidence, "unverified", 30).toLowerCase()) ? salesString(data.research_confidence, "unverified", 30).toLowerCase() : "unverified", now, actor.id).run();
      if (typeof data.contact_source_url === "string" && /^https:\/\//i.test(data.contact_source_url)) await env.DB.prepare("INSERT INTO sales_research_sources (id, record_id, source_type, title, url, fact_summary, confidence, captured_at, added_by) VALUES (?, ?, 'contact_verification', 'Contact information source', ?, 'Source supplied for the lead contact details.', 'unverified', ?, ?)")
        .bind(crypto.randomUUID(), id, data.contact_source_url.slice(0, 1000), now, actor.id).run();
      return json({ id, created_at: now }, 201, salesCors(request, env));
    }
    const match = path.match(/^\/v1\/sales\/records\/([\w-]+)$/);
    if (match && request.method === "PATCH") {
      const old = await env.DB.prepare("SELECT * FROM sales_records WHERE id = ?").bind(match[1]).all<Record<string, unknown>>();
      const row = old.results?.[0];
      if (!row) return json({ error: "Record not found" }, 404, salesCors(request, env));
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(String(row.data_json || "{}")); } catch { prev = {}; }
      const patch = salesObject(await request.json());
      const data = salesObject({ ...prev, ...patch });
      const stage = salesString(data.stage, String(row.stage), 40);
      if (row.entity_type === "lead" && !SALES_STAGES.has(stage)) return json({ error: "Unknown lead stage" }, 400, salesCors(request, env));
      const name = salesString(data.company_name ?? data.name, String(row.name), 160);
      const now = new Date().toISOString();
      await env.DB.prepare(`UPDATE sales_records SET name = ?, stage = ?, industry = ?, status = ?, monthly_revenue = ?, total_value = ?, probability = ?, next_follow_up = ?, contract_end = ?, last_contact = ?, data_json = ?, updated_at = ? WHERE id = ?`)
        .bind(name, stage, salesString(data.industry, String(row.industry), 100), salesString(data.status, String(row.status), 30),
          salesNumber(data.monthly_revenue ?? data.estimated_monthly_value, Number(row.monthly_revenue)), salesNumber(data.total_value ?? data.estimated_total_value, Number(row.total_value)),
          Math.min(100, Math.round(salesNumber(data.probability, Number(row.probability)))), salesDate(data.next_follow_up), salesDate(data.contract_end ?? data.contract_expiration_date),
          salesDate(data.last_contact), JSON.stringify(data), now, match[1]).run();
      await audit(env, actor, "record_updated", String(row.entity_type), match[1], { changed_fields: Object.keys(patch) });
      if (typeof data.contact_source_url === "string" && /^https:\/\//i.test(data.contact_source_url) && data.contact_source_url !== prev.contact_source_url) await env.DB.prepare("INSERT INTO sales_research_sources (id, record_id, source_type, title, url, fact_summary, confidence, captured_at, added_by) VALUES (?, ?, 'contact_verification', 'Contact information source', ?, 'Source supplied for the lead contact details.', 'unverified', ?, ?)")
        .bind(crypto.randomUUID(), match[1], data.contact_source_url.slice(0, 1000), now, actor.id).run();
      if (data.stage !== prev.stage && row.entity_type === "lead") {
        await env.DB.prepare("INSERT INTO sales_activities (id, record_id, activity_type, summary, occurred_at, created_at) VALUES (?, ?, 'stage_change', ?, ?, ?)")
          .bind(crypto.randomUUID(), match[1], `Stage changed to ${stage}`, now, now).run();
      }
      return json({ id: match[1], updated_at: now }, 200, salesCors(request, env));
    }
    if (match && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM sales_records WHERE id = ?").bind(match[1]).run();
      await audit(env, actor, "record_deleted", "sales_record", match[1]);
      return json({ deleted: true }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/activities" && request.method === "GET") {
      const id = url.searchParams.get("record_id");
      if (!id) return json({ error: "record_id is required" }, 400, salesCors(request, env));
      const rows = await env.DB.prepare("SELECT * FROM sales_activities WHERE record_id = ? ORDER BY occurred_at DESC LIMIT 100").bind(id).all();
      return json({ activities: rows.results ?? [] }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/activities" && request.method === "POST") {
      const body = salesObject(await request.json()), recordId = salesString(body.record_id, "", 80), summary = salesString(body.summary, "", 1000);
      if (!recordId || !summary) return json({ error: "record_id and summary are required" }, 400, salesCors(request, env));
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO sales_activities (id, record_id, activity_type, summary, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), recordId, salesString(body.activity_type, "note", 40), summary, salesDate(body.occurred_at) ? `${body.occurred_at}T12:00:00Z` : now, now).run();
      await audit(env, actor, "activity_logged", "sales_record", recordId, { activity_type: salesString(body.activity_type, "note", 40) });
      return json({ saved: true }, 201, salesCors(request, env));
    }
    return json({ error: "Not found" }, 404, salesCors(request, env));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message.slice(0, 240) : "Sales request failed" }, 400, salesCors(request, env));
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/mcp" || url.pathname === "/authorize" || url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/")) {
      const { handleMcpRequest } = await import("./mcp");
      return handleMcpRequest(request, env, ctx);
    }
    if (url.pathname === "/v1/sales/gmail/callback") return handleGmailCallback(request, env);
    if (url.pathname.startsWith("/v1/crm/")) return crmRoute(request, env, url);
    if (url.pathname.startsWith("/v1/sales/")) {
      return salesRoute(request, env, url);
    }
    return json({ error: "Not found" }, 404);
  },
  async scheduled(_controller: unknown, env: Env, context: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    context.waitUntil(scheduledGmailSync(env));
  },
};
