/// <reference path="./agents-mcp-server.d.ts" />
import {
  AuthorizationError,
  OAuthAuthorizationServer,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

interface KVNamespace {
  get(key: string, type: "json"): Promise<Record<string, unknown> | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
interface Env {
  DB: { prepare(query: string): { bind(...values: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> } } };
  OAUTH_KV: KVNamespace;
  MCP_SERVER_URL?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_ENVIRONMENT?: string;
  MCP_SERVICE_NAME?: string;
  MCP_CRM_API_BASE_URL?: string;
  MCP_CRM_API_TOKEN?: string;
  MCP_AUTH_PASSWORD?: string;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
}
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }

const MCP_SCOPES = ["crm:read", "crm:write", "offline_access"] as const;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function oauthServer(env: Env, request: Request): OAuthAuthorizationServer<Env> {
  const origin = new URL(request.url).origin;
  return new OAuthAuthorizationServer<Env>({
    issuer: env.MCP_OAUTH_ISSUER || origin,
    resources: [env.MCP_SERVER_URL || `${origin}/mcp`],
    scopesSupported: [...MCP_SCOPES],
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
  });
}

function consentHtml(details: { clientName: string; clientDomain?: string; redirectHost: string; redirectIsLoopback: boolean; scope: string[] }, handle: string, serviceName: string, environmentName: string, error = ""): string {
  const scopes = details.scope.filter((scope) => (MCP_SCOPES as readonly string[]).includes(scope));
  const scopeFields = scopes.map((scope) => `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`).join("<br>");
  const domain = details.clientDomain ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.` : "The client name is not verified by a published domain.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${escapeHtml(serviceName)}</title><style>body{font:16px system-ui;background:#10171e;color:#eef4f8;margin:0;padding:32px}.box{max-width:560px;margin:5vh auto;padding:28px;background:#19242e;border:1px solid #32414d;border-radius:12px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;margin:8px 0 18px;background:#10171e;color:white;border:1px solid #455562;border-radius:6px}button{padding:10px 18px;margin:12px 8px 0 0;border:0;border-radius:6px;font-weight:700}.allow{background:#4cbd96;color:#071c15}.deny{background:#263746;color:white}.error{color:#ff9d9d}</style></head><body><main class="box"><h1>Connect ${escapeHtml(serviceName)}</h1><p><strong>${escapeHtml(details.clientName)}</strong>. ${domain}</p><p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong></p>" : ""}<p>Enter your ${escapeHtml(environmentName)} access passphrase, then approve the requested access.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" autocomplete="off"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><label for="passphrase">${escapeHtml(environmentName)} access passphrase</label><input id="passphrase" name="passphrase" type="password" required autocomplete="current-password" maxlength="512">${scopeFields}<p><button class="allow" name="decision" value="approve">Approve</button><button class="deny" name="decision" value="deny">Deny</button></p></form></main></body></html>`;
}

function environmentName(env: Env): string {
  return env.MCP_ENVIRONMENT === "production" ? "production" : env.MCP_ENVIRONMENT === "staging" ? "staging" : "configured";
}

function serviceName(env: Env): string {
  return env.MCP_SERVICE_NAME || "10K Hub CRM";
}

async function digestHex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function checkPassphrase(supplied: string, expected: string): Promise<boolean> {
  if (supplied.length > 512 || expected.length < 32) return false;
  const [a, b] = await Promise.all([digestHex(supplied), digestHex(expected)]);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function authorize(request: Request, env: Env): Promise<Response> {
  const server = oauthServer(env, request);
  const oauth = server.getOAuthApi(env);
  if (request.method === "GET") {
    const failureKey = `mcp-auth-fail:${await digestHex(request.headers.get("CF-Connecting-IP") || "unknown")}`;
    const failures = Number((await env.OAUTH_KV.get(failureKey, "json"))?.count || 0);
    if (failures >= 5) return new Response("Too many attempts. Wait five minutes, then restart the ChatGPT connection.", { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });
    try {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Cache-Control", "no-store");
      return new Response(consentHtml(details, consent.handle, serviceName(env), environmentName(env)), { headers: consent.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      return new Response("Invalid OAuth authorization request.", { status: 400, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  if (!env.MCP_AUTH_PASSWORD || env.MCP_AUTH_PASSWORD.length < 32) return new Response(`${environmentName(env)} OAuth passphrase is not configured.`, { status: 503 });
  const form = await request.formData();
  const handle = String(form.get("handle") || "");
  const passphrase = String(form.get("passphrase") || "");
  const decision = String(form.get("decision") || "");
  if (!handle || handle.length > 256) return new Response("Authorization form expired. Reconnect from ChatGPT.", { status: 400 });
  if (decision !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const failureKey = `mcp-auth-fail:${await digestHex(request.headers.get("CF-Connecting-IP") || "unknown")}`;
  const failures = Number((await env.OAUTH_KV.get(failureKey, "json"))?.count || 0);
  if (failures >= 5) return new Response("Too many attempts. Wait five minutes, then restart the ChatGPT connection.", { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });
  if (!(await checkPassphrase(passphrase, env.MCP_AUTH_PASSWORD))) {
    await env.OAUTH_KV.put(failureKey, JSON.stringify({ count: failures + 1 }), { expirationTtl: 300 });
    return new Response("Incorrect passphrase. Restart the ChatGPT connection and try again.", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  await env.OAUTH_KV.delete(failureKey);
  try {
    const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "jack",
      metadata: { display_name: "Jack Leverentz", workspace: serviceName(env) },
      scope: approved.request.scope.filter((scope) => (MCP_SCOPES as readonly string[]).includes(scope)),
      props: { userId: "jack", displayName: "Jack Leverentz" },
    });
    return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return new Response("Authorization expired. Reconnect from ChatGPT.", { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const merged = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Response(JSON.stringify(data), { status, headers: merged });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

async function crmCall(env: Env, path: string, method = "GET", body?: Record<string, unknown>, toolName = "") {
  if (!env.MCP_CRM_API_TOKEN || !env.MCP_CRM_API_BASE_URL) throw new Error(`${environmentName(env)} CRM adapter is not configured.`);
  const headers = new Headers({ Authorization: `Bearer ${env.MCP_CRM_API_TOKEN}`, Accept: "application/json" });
  if (body) {
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", `mcp:${await digestHex(`${toolName}:${path}:${canonicalJson(body)}`)}`);
  }
  // workerd supports only `follow` and `manual` for RequestInit.redirect. Use
  // `manual` and explicitly reject redirects so the CRM token is never forwarded.
  const response = await fetch(new URL(path, env.MCP_CRM_API_BASE_URL), { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("CRM API redirect refused.");
  const text = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { payload = { error: "CRM API returned invalid JSON." }; }
  return { ok: response.ok, status: response.status, payload };
}

function makeMcpServer(env: Env, scope: string[], metadataUrl: string, authenticatedUserId: string | undefined) {
  const server = new McpServer({ name: serviceName(env), version: "1.0.0" });
  const add = (name: string, description: string, schema: Record<string, z.ZodTypeAny>, method: string, path: (args: Record<string, unknown>) => string, buildBody?: (args: Record<string, unknown>) => Record<string, unknown>) => {
    const write = method !== "GET";
    const requiredScopes = write ? ["crm:read", "crm:write", "offline_access"] : ["crm:read", "offline_access"];
    const missingScopes = !scope.includes("crm:read") || (write && !scope.includes("crm:write"));
    server.registerTool(name, {
      title: name.replaceAll("_", " "),
      description: `${write ? "Writes CRM data. " : "Read-only. "}${description}`,
      inputSchema: schema,
      _meta: { securitySchemes: [{ type: "oauth2", scopes: requiredScopes }] },
    }, async (args: Record<string, unknown>) => {
      if (missingScopes) return {
        isError: true,
        content: [{ type: "text", text: "Connect or reconnect the 10K Hub CRM and approve the requested scopes." }],
        _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="The selected CRM tool needs additional authorization scopes."`] },
      };
      try {
        const result = await crmCall(env, path(args), method, buildBody?.(args), name);
        const text = JSON.stringify(result.payload);
        return { isError: !result.ok, content: [{ type: "text", text: text.slice(0, 12000) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "CRM request failed." }] };
      }
    });
  };
  const opt = <T extends z.ZodTypeAny>(schema: T) => schema.optional();
  const str = (max = 1000) => z.string().max(max);
  const record = (fields: string[]) => Object.fromEntries(fields.map((field) => [field, str(field.endsWith("_url") || field === "website" ? 1000 : 2000).optional()]));

  server.registerTool("get_crm_environment", {
    title: "Get CRM environment",
    description: "Read-only. Reports the server-configured environment and this connection's CRM permissions. It does not read or change CRM records.",
    inputSchema: {},
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["crm:read", "offline_access"] }] },
  }, async () => {
    if (!scope.includes("crm:read")) return {
      isError: true,
      content: [{ type: "text", text: "Connect or reconnect the 10K Hub CRM and approve CRM read access." }],
      _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="This tool requires CRM read access."`] },
    };
    const authenticatedPermissions = scope.filter((granted) => granted === "crm:read" || granted === "crm:write");
    return {
      content: [{ type: "text", text: JSON.stringify({
        environment: env.MCP_ENVIRONMENT || "unconfigured",
        service_name: env.MCP_SERVICE_NAME || "10K Hub Partnerships CRM",
        deployment_version: env.CF_VERSION_METADATA?.id || "unavailable",
        authenticated_permissions: authenticatedPermissions,
        write_access_enabled: scope.includes("crm:write"),
      }) }],
    };
  });

  // OpenAI uses the marked profile tool to identify the same authenticated
  // account after token refresh or reconnection, avoiding duplicate links.
  // IDs are fixed per account and deliberately opaque; never derive them from
  // a caller-supplied tool argument or display name.
  const profileOutput = z.object({
    id: z.string().min(1).describe("Opaque, stable profile identifier."),
    name: z.string().optional().describe("Display name for the authenticated profile."),
    nickname: z.string().optional().describe("Label distinguishing this environment's connection."),
  });
  server.registerTool("get_crm_profile", {
    title: "Get CRM account profile",
    description: "Read-only. Returns the identity and environment label for the account authenticated by this connection. Does not read or change CRM records.",
    inputSchema: {},
    outputSchema: profileOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: {
      "openai/profile": true,
      securitySchemes: [{ type: "oauth2", scopes: ["crm:read", "offline_access"] }],
    },
  }, async () => {
    if (!scope.includes("crm:read") || !authenticatedUserId) return {
      isError: true,
      content: [{ type: "text", text: "Connect the 10K Hub CRM with CRM read access to identify this account." }],
      _meta: { "mcp/www_authenticate": [`Bearer resource_metadata="${metadataUrl}", error="insufficient_scope", error_description="This tool requires an authenticated CRM read connection."`] },
    };
    const profileNames: Record<string, string> = { jack: "Jack Leverentz" };
    const name = profileNames[authenticatedUserId];
    if (!name) return { isError: true, content: [{ type: "text", text: "No profile is configured for this authenticated account." }] };
    const environment = env.MCP_ENVIRONMENT || "unconfigured";
    const id = environment === "staging" && authenticatedUserId === "jack"
      ? "prf_8c1b1f27-95ae-4b21-91a8-6de2ef43071d"
      : `prf_${(await digestHex(`10k-hub-crm-profile:v1:${environment}:${authenticatedUserId}`)).slice(0, 32)}`;
    const nickname = environment === "production" ? "10K Hub CRM — Production" : environment === "staging" ? "10K Hub CRM — Staging" : serviceName(env);
    const profile = { id, name, nickname };
    return { content: [{ type: "text", text: JSON.stringify(profile) }], structuredContent: profile };
  });

  add("search_companies", "Search existing canonical companies before creating anything.", { query: opt(str(160)), limit: opt(z.number().int().min(1).max(100)) }, "GET", (a) => `/v1/crm/companies?q=${encodeURIComponent(String(a.query || ""))}&limit=${Number(a.limit || 50)}`);
  add("search_contacts", "Search contacts by name/email or within a company. Multiple employees may be linked to one company.", { query: opt(str(160)), company_id: opt(str(80)) }, "GET", (a) => `/v1/crm/contacts?q=${encodeURIComponent(String(a.query || ""))}${a.company_id ? `&company_id=${encodeURIComponent(String(a.company_id))}` : ""}`);
  add("search_prospects", "Search saved prospect records by company, industry, fit, or campaign-opportunity text. Use get_research_notes for standalone company notes.", { query: opt(str(160)), limit: opt(z.number().int().min(1).max(100)) }, "GET", (a) => `/v1/crm/prospects?q=${encodeURIComponent(String(a.query || ""))}&limit=${Number(a.limit || 50)}`);
  add("get_research_notes", "Retrieve standalone research notes for a canonical company. This is read-only and requires its company ID.", { company_id: str(80), limit: opt(z.number().int().min(1).max(100)) }, "GET", (a) => `/v1/crm/research-notes?company_id=${encodeURIComponent(String(a.company_id))}&limit=${Number(a.limit || 50)}`);
  add("search_opportunities", "List existing lead opportunities from the current sales_records model.", {}, "GET", () => "/v1/crm/opportunities");
  add("get_communication_history", "Read Gmail communication metadata and separate Resend outreach records for a company or contact.", { company_id: opt(str(80)), contact_id: opt(str(80)) }, "GET", (a) => `/v1/crm/communications?${a.company_id ? `company_id=${encodeURIComponent(String(a.company_id))}` : `contact_id=${encodeURIComponent(String(a.contact_id || ""))}`}`);
  add("list_follow_up_tasks", "List follow-up tasks by optional status: open, completed, or cancelled.", { status: opt(z.enum(["open", "completed", "cancelled"])) }, "GET", (a) => `/v1/crm/follow-up-tasks${a.status ? `?status=${encodeURIComponent(String(a.status))}` : ""}`);
  add("create_company", "Create a canonical company only after searching for a match. This does not create a lead or client record.", { name: str(160), industry: opt(str(100)), website: opt(str(1000)), notes: opt(str(2000)) }, "POST", () => "/v1/crm/companies", (a) => a);
  add("update_company", "Update an existing canonical company without replacing unrelated CRM records.", { id: str(80), ...record(["name", "industry", "website", "notes"]) }, "PATCH", (a) => `/v1/crm/companies/${encodeURIComponent(String(a.id))}`, (a) => { const { id, ...body } = a; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); });
  add("save_contact", "Create or link a contact. Search first; the CRM deduplicates by email and allows multiple contacts per company. Only store evidence-backed emails.", { display_name: str(160), email: opt(str(254)), title: opt(str(160)), phone: opt(str(80)), notes: opt(str(2000)), company_ids: opt(z.array(str(80)).max(20)), relationship_role: opt(str(160)), email_source_url: opt(str(1000)), confidence: opt(z.enum(["unverified", "low", "medium", "high"])) }, "POST", () => "/v1/crm/contacts", (a) => a);
  add("update_contact", "Update an existing contact. The email must be sourced and verified before replacing it.", { id: str(80), display_name: opt(str(160)), title: opt(str(160)), phone: opt(str(80)), notes: opt(str(2000)), email: opt(str(254)), email_source_url: opt(str(1000)), confidence: opt(z.enum(["unverified", "low", "medium", "high"])) }, "PATCH", (a) => `/v1/crm/contacts/${encodeURIComponent(String(a.id))}`, (a) => { const { id, ...body } = a; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); });
  add("save_prospect", "Create a prospect research record for an existing canonical company. Search companies, prospects, contacts, and leads first. The API prevents a second prospect record for the same company. Source URLs must be HTTPS.", { company_id: str(80), company_description: opt(str(1000)), fit_reason: opt(str(1000)), campaign_opportunities: opt(str(1000)), lead_category: opt(z.enum(["brand", "agency"])), location: opt(str(160)), source_name: opt(str(160)), source_url: opt(str(1000)), research_confidence: opt(z.enum(["unverified", "low", "medium", "high"])), researched_at: opt(str(10)), notes: opt(str(2000)) }, "POST", () => "/v1/crm/prospects", (a) => a);
  add("update_prospect", "Update evidence-backed research on an existing prospect. Source URLs must be HTTPS.", { id: str(80), ...record(["company_description", "fit_reason", "campaign_opportunities", "lead_category", "location", "source_name", "source_url", "research_confidence", "researched_at", "notes"]) }, "PATCH", (a) => `/v1/crm/prospects/${encodeURIComponent(String(a.id))}`, (a) => { const { id, ...body } = a; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); });
  add("promote_prospect_to_lead", "Promote an approved prospect to a New-stage lead after checking that no lead already exists. Existing sales_records opportunities are preserved.", { id: str(80) }, "POST", (a) => `/v1/crm/prospects/${encodeURIComponent(String(a.id))}/promote`, () => ({}));
  add("save_research_note", "Save a research note and optional HTTPS source to a canonical company.", { company_id: str(80), note: str(2000), source_url: opt(str(1000)), title: opt(str(160)), confidence: opt(z.enum(["unverified", "low", "medium", "high"])) }, "POST", () => "/v1/crm/research-notes", (a) => a);
  add("update_opportunity", "Update an existing lead opportunity using the existing stages and sales_records model.", { id: str(80), stage: opt(z.enum(["New", "Contacted", "Proposal Sent", "Closed"])), status: opt(str(30)), monthly_revenue: opt(z.number().nonnegative()), total_value: opt(z.number().nonnegative()), probability: opt(z.number().min(0).max(100)), next_follow_up: opt(str(10)), notes: opt(str(2000)), pipeline_outcome: opt(str(80)), win_loss_reason: opt(str(1000)) }, "PATCH", (a) => `/v1/crm/opportunities/${encodeURIComponent(String(a.id))}`, (a) => { const { id, ...body } = a; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); });
  add("create_follow_up_task", "Create a follow-up task for an existing company. Due date must be YYYY-MM-DD; use a stable dedupe key where available.", { company_id: str(80), title: str(240), due_at: str(10), record_id: opt(str(80)), contact_id: opt(str(80)), task_type: opt(str(60)), notes: opt(str(2000)), assigned_to: opt(str(80)), dedupe_key: opt(str(300)) }, "POST", () => "/v1/crm/follow-up-tasks", (a) => a);
  add("update_follow_up_task", "Reschedule, reassign, complete, reopen, or cancel an existing follow-up task.", { id: str(80), title: opt(str(240)), notes: opt(str(2000)), assigned_to: opt(str(80)), due_at: opt(str(10)), status: opt(z.enum(["open", "completed", "cancelled"])) }, "PATCH", (a) => `/v1/crm/follow-up-tasks/${encodeURIComponent(String(a.id))}`, (a) => { const { id, ...body } = a; return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)); });
  return server;
}

export async function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const server = oauthServer(env, request);
  if (url.pathname === "/authorize") return authorize(request, env);
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    const resource = env.MCP_SERVER_URL || `${url.origin}/mcp`;
    return json({ resource, authorization_servers: [env.MCP_OAUTH_ISSUER || url.origin], bearer_methods_supported: ["header"], scopes_supported: [...MCP_SCOPES] });
  }
  if (url.pathname.startsWith("/.well-known/") || url.pathname.startsWith("/oauth/")) return server.fetch(request, env, ctx as ExecutionContext);

  if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404);
  const expectedHost = new URL(env.MCP_SERVER_URL || `${url.origin}/mcp`).host;
  if (request.headers.get("Host") !== expectedHost) return json({ error: "Invalid host" }, 400);
  if (request.method !== "POST") return json({ error: "MCP endpoint accepts POST requests only." }, 405, { Allow: "POST" });
  const resource = env.MCP_SERVER_URL || `${url.origin}/mcp`;
  const auth = request.headers.get("Authorization") || "";
  // Cloudflare's OAuth provider issues opaque tokens in userId:grantId:random form.
  // Keep the value constrained, but allow the colons so valid OAuth credentials are
  // passed through to validateToken instead of being mistaken for missing auth.
  const tokenMatch = auth.match(/^Bearer ([A-Za-z0-9._~:-]{16,4096})$/);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
  let token: Awaited<ReturnType<typeof server.validateToken>> | null = null;
  if (tokenMatch) try { token = await server.validateToken(resource, tokenMatch[1], env); } catch (error) {
    console.warn("mcp_token_validation_failed", { errorType: error instanceof Error ? error.name : "unknown" });
  }

  let message: Record<string, unknown>;
  try { message = await request.json() as Record<string, unknown>; }
  catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const id = message.id;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } }, 400);
  const requestParams = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
  console.info("mcp_request", {
    method: message.method,
    toolName: message.method === "tools/call" && typeof requestParams.name === "string" ? requestParams.name : undefined,
    bearerTokenPresent: Boolean(tokenMatch),
    bearerTokenValid: Boolean(token),
    scopes: token?.scope || [],
  });
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  if (message.method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (message.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: String((message.params as Record<string, unknown> | undefined)?.protocolVersion || "2025-11-25"), capabilities: { tools: { listChanged: false } }, serverInfo: { name: serviceName(env), version: "1.0.0" } } });
  const mcp = createMcpHandler(() => makeMcpServer(env, token?.scope || [], metadataUrl, token?.userId), {
    route: "/mcp",
    corsOptions: false,
    onerror: (error: Error) => console.error("mcp_handler_error", { errorType: error.name }),
  });
  const response = await mcp.fetch(request, { parsedBody: message });
  console.info("mcp_response", { method: message.method, status: response.status });
  return response;
}
