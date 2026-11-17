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
      if (!env.AI) return json({ error: "AI is not enabled on this Worker. Configure the optional Cloudflare Workers AI binding, deploy it, then retry." }, 503, salesCors(request, env));
      const body = salesObject(await request.json()), task = salesString(body.task, "advice", 30), context = salesString(body.context, "", 6000);
      if (!context) return json({ error: "Provide CRM facts to analyze" }, 400, salesCors(request, env));
      const roleTask = task === "contact_roles" ? "For this task, suggest relevant job titles only. Return suggested_roles as an array of objects with title, why_relevant, and public_search_terms. Do not claim to have searched the web. Do not name or infer specific employees, titles held by supplied contacts, verified contact details, budget, or buying intent. If a contact is supplied without a title, explicitly say their role is unknown. Make clear the role titles are research suggestions, not verified people." : "";
      const prompt = `You are a cautious sponsorship sales assistant for 10K Takes, a Minnesota sports media business. Return only valid JSON, without Markdown fences, with keys: summary (string), score (integer 0-100 or null), score_breakdown (array of {criterion,points,max,evidence}), confidence (low, medium, or high), suggested_roles (array of {title,why_relevant,public_search_terms}), evidence (array), next_steps (array), assumptions (array), draft (string). Task: ${task}. ${roleTask} Use only facts in the supplied context. Do not infer facts from a company name or invent contacts, budgets, audience metrics, or deal terms. Mark uncertainty and keep all advice as a draft for human review. If task is score, give an editorial fit ranking (not a probability of winning) using: brand/audience fit 0-30, Minnesota relevance 0-20, documented sponsorship or marketing activity 0-20, activation fit for 10K Takes 0-15, and verified contactability 0-15. Award points only when supported by context; missing evidence receives zero points and must be named as a data gap, not treated as proof of poor fit. Return null only if the context contains no usable company or fit information beyond the company name. For other tasks, score may be null. Context: ${context}`;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (url.pathname.startsWith("/v1/sales/")) {
      return salesRoute(request, env, url);
    }
    return json({ error: "Not found" }, 404);
  },
};
