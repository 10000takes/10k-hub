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
  PUBLIC_READ_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

const SALES_TYPES = new Set(["client", "lead", "prospect"]);
const SALES_STAGES = new Set(["Discovered", "Qualified", "Contact Identified", "Outreach Sent", "Conversation Started", "Meeting Scheduled", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost", "Nurture"]);
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

function authorized(request: Request, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
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
  if (!authorized(request, env.SALES_API_TOKEN)) return json({ error: "Unauthorized" }, 401, salesCors(request, env));
  const path = url.pathname.replace(/\/+$/, "");
  try {
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
      return json({ id }, 201, salesCors(request, env));
    }
    if (path === "/v1/sales/deliverables/completions" && request.method === "POST") {
      const body = salesObject(await request.json()), definitionId = salesString(body.definition_id, "", 80), month = salesString(body.month, "", 7);
      if (!definitionId || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ error: "definition_id and month (YYYY-MM) are required" }, 400, salesCors(request, env));
      const units = Math.round(salesNumber(body.completed_units)); if (units < 0) return json({ error: "completed_units must be zero or greater" }, 400, salesCors(request, env));
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO deliverable_monthly (id, definition_id, month, completed_units, completed_at, published_url, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(definition_id, month) DO UPDATE SET completed_units=excluded.completed_units, completed_at=excluded.completed_at, published_url=excluded.published_url, notes=excluded.notes, updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(), definitionId, month, units, units ? now : null, salesString(body.published_url, "", 500), salesString(body.notes, "", 1000), now).run();
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
      const prompt = `You are a cautious sponsorship sales assistant for 10K Takes, a Minnesota sports media business. Return concise JSON with keys: summary, score (integer 0-100 or null), evidence (array), next_steps (array), assumptions (array), draft (string). Task: ${task}. Use only facts in the supplied context. Do not invent contacts, budgets, audience metrics, or deal terms. Mark uncertainty and keep all advice as a draft for human review. Context: ${context}`;
      const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages: [{ role: "user", content: prompt }], max_tokens: 700 });
      return json({ result, model: "@cf/meta/llama-3.1-8b-instruct", disclaimer: "AI output is a draft based only on supplied facts; review before using." }, 200, salesCors(request, env));
    }
    if (path === "/v1/sales/outreach" && request.method === "POST") {
      const body = salesObject(await request.json());
      if (body.confirm_send !== true) return json({ error: "Email is sent only after an explicit confirm_send approval." }, 400, salesCors(request, env));
      if (!env.RESEND_API_KEY || !env.RESEND_FROM) return json({ error: "Email sending is not configured. Add RESEND_API_KEY and RESEND_FROM Worker secrets after verifying the sender domain." }, 503, salesCors(request, env));
      const recipient = salesString(body.to, "", 254), subject = salesString(body.subject, "", 200), content = salesString(body.body, "", 10000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || !subject || !content) return json({ error: "A valid recipient, subject, and message body are required." }, 400, salesCors(request, env));
      const sent = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: env.RESEND_FROM, to: [recipient], subject, text: content }) });
      const result = await sent.json() as Record<string, unknown>;
      if (!sent.ok) return json({ error: "Email provider rejected the request", details: result }, sent.status, salesCors(request, env));
      const now = new Date().toISOString(), leadId = salesString(body.lead_id, "", 80);
      await env.DB.prepare("INSERT INTO outreach_log (id, lead_id, recipient, subject, body, provider_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), leadId || null, recipient, subject, content, salesString(result.id, "", 160), now).run();
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
      const stage = salesString(data.stage, type === "lead" ? "Discovered" : "", 40);
      if (type === "lead" && !SALES_STAGES.has(stage)) return json({ error: "Unknown lead stage" }, 400, salesCors(request, env));
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO sales_records (id, entity_type, name, stage, industry, status, monthly_revenue, total_value, probability, next_follow_up, contract_end, last_contact, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, type, name, stage, salesString(data.industry, "", 100), salesString(data.status, type === "client" ? "active" : "open", 30),
          salesNumber(data.monthly_revenue ?? data.estimated_monthly_value), salesNumber(data.total_value ?? data.estimated_total_value),
          Math.min(100, Math.round(salesNumber(data.probability))), salesDate(data.next_follow_up), salesDate(data.contract_end ?? data.contract_expiration_date),
          salesDate(data.last_contact), JSON.stringify(data), now, now).run();
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
      if (data.stage !== prev.stage && row.entity_type === "lead") {
        await env.DB.prepare("INSERT INTO sales_activities (id, record_id, activity_type, summary, occurred_at, created_at) VALUES (?, ?, 'stage_change', ?, ?, ?)")
          .bind(crypto.randomUUID(), match[1], `Stage changed to ${stage}`, now, now).run();
      }
      return json({ id: match[1], updated_at: now }, 200, salesCors(request, env));
    }
    if (match && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM sales_records WHERE id = ?").bind(match[1]).run();
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
