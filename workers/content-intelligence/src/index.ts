interface D1Result<T = unknown> { results?: T[] }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}
interface Env {
  DB: D1Database;
  AGENT_TOKEN?: string;
  SALES_API_TOKEN?: string;
  PUBLIC_READ_ORIGIN?: string;
}

interface IncomingPost {
  snapshot_date: string;
  platform: string;
  url: string;
  posted_at: string;
  format: string;
  caption: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

interface StoredSnapshot {
  content_id: string;
  platform: string;
  url: string;
  posted_at: string;
  format: string;
  caption: string;
  hashtags_json: string;
  snapshot_date: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

interface ComparedPost {
  content_id: string;
  platform: string;
  url: string;
  posted_at: string;
  format: string;
  hashtags: string[];
  start_date: string;
  end_date: string;
  views_delta: number | null;
  engagements_delta: number | null;
}

const MAX_IMPORT_ITEMS = 500;
const MIN_POSTS_PER_COHORT = 3;
const MIN_VIEW_UPLIFT = 0.25;
const MIN_RELATIVE_ENGAGEMENT = 0.8;
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

function normalizedLabel(value: unknown, name: string, maxLength = 60): string {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const result = value.trim().replace(/\s+/g, " ");
  if (!result || result.length > maxLength) throw new Error(`${name} must be 1–${maxLength} characters`);
  return result;
}

function dateOnly(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${name} is not a valid date`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error(`${name} must include a timezone`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

function counter(value: unknown, name: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer or null`);
  return value;
}

function canonicalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("url must be text under 2048 characters");
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("url must be an absolute http(s) URL"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("url must be an http(s) URL");
  const youtubeId = parsed.searchParams.get("v");
  if (parsed.hostname.toLowerCase().endsWith("youtube.com") && youtubeId) return `https://youtube.com/watch?v=${youtubeId}`;
  parsed.hash = "";
  parsed.search = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function tagsFromCaption(caption: string): string[] {
  return [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu)?.map((tag) => tag.slice(1).toLowerCase()) ?? [])].slice(0, 12);
}

function validatePost(value: unknown): IncomingPost {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each item must be an object");
  const row = value as Record<string, unknown>;
  const caption = typeof row.caption === "string" ? row.caption.trim().slice(0, 280) : "";
  return {
    snapshot_date: dateOnly(row.snapshot_date, "snapshot_date"),
    platform: normalizedLabel(row.platform, "platform"),
    url: canonicalUrl(row.url),
    posted_at: timestamp(row.posted_at, "posted_at"),
    format: normalizedLabel(row.format || "Post", "format"),
    caption,
    views: counter(row.views, "views"),
    likes: counter(row.likes, "likes"),
    comments: counter(row.comments, "comments"),
    shares: counter(row.shares, "shares"),
    saves: counter(row.saves, "saves"),
  };
}

async function contentId(platform: string, url: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${platform.toLowerCase()}|${url}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
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

function corsHeaders(request: Request, env: Env): HeadersInit {
  if (!originMatches(request, env)) return {};
  return {
    "Access-Control-Allow-Origin": env.PUBLIC_READ_ORIGIN!,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function engagement(post: Pick<StoredSnapshot, "likes" | "comments" | "shares" | "saves">): number | null {
  const counters = [post.likes, post.comments, post.shares, post.saves];
  if (counters.some((n) => n === null)) return null;
  return counters.reduce<number>((sum, n) => sum + n!, 0);
}

function delta(now: number | null, before: number | null): number | null {
  if (now === null || before === null || now < before) return null;
  return now - before;
}

function dayDistance(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function pairedPosts(rows: StoredSnapshot[]): ComparedPost[] {
  const byContent = new Map<string, StoredSnapshot[]>();
  for (const row of rows) byContent.set(row.content_id, [...(byContent.get(row.content_id) ?? []), row]);
  const result: ComparedPost[] = [];
  for (const [id, snapshots] of byContent) {
    snapshots.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    if (snapshots.length < 2) continue;
    const current = snapshots[snapshots.length - 1];
    const prior = snapshots.slice(0, -1)
      .filter((s) => dayDistance(current.snapshot_date, s.snapshot_date) >= 6 && dayDistance(current.snapshot_date, s.snapshot_date) <= 8)
      .sort((a, b) => Math.abs(dayDistance(current.snapshot_date, a.snapshot_date) - 7) - Math.abs(dayDistance(current.snapshot_date, b.snapshot_date) - 7))[0];
    if (!prior) continue;
    let hashtags: string[] = [];
    try { hashtags = JSON.parse(current.hashtags_json) as string[]; } catch { hashtags = []; }
    result.push({
      content_id: id,
      platform: current.platform,
      url: current.url,
      posted_at: current.posted_at,
      format: current.format,
      hashtags,
      start_date: prior.snapshot_date,
      end_date: current.snapshot_date,
      views_delta: delta(current.views, prior.views),
      engagements_delta: delta(engagement(current), engagement(prior)),
    });
  }
  return result;
}

function recommendationConfidence(sample: number): "low" | "medium" | "high" {
  if (sample >= 8) return "high";
  if (sample >= 5) return "medium";
  return "low";
}

async function analyze(env: Env): Promise<{ runId: string; snapshotAsOf: string | null; comparedPosts: number; recommendationsCreated: number; status: string; note: string }> {
  const runId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await env.DB.prepare("INSERT INTO analysis_runs (id, created_at, status) VALUES (?, ?, 'failed')").bind(runId, createdAt).run();
  try {
    const startDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
    const query = await env.DB.prepare(
      `SELECT c.id AS content_id, c.platform, c.url, c.posted_at, c.format, c.caption, c.hashtags_json,
              s.snapshot_date, s.views, s.likes, s.comments, s.shares, s.saves
       FROM metric_snapshots s JOIN content_items c ON c.id = s.content_id
       WHERE s.snapshot_date >= ? ORDER BY s.snapshot_date ASC`,
    ).bind(startDate).all<StoredSnapshot>();
    const rows = query.results ?? [];
    const posts = pairedPosts(rows);
    const snapshotAsOf = rows.map((row) => row.snapshot_date).sort().at(-1) ?? null;
    const withViews = posts.filter((post) => post.views_delta !== null);
    const platforms = new Map<string, ComparedPost[]>();
    for (const post of withViews) {
      const key = JSON.stringify([post.platform.toLowerCase(), post.format.toLowerCase()]);
      platforms.set(key, [...(platforms.get(key) ?? []), post]);
    }

    const candidates: Array<{ platform: string; format: string; topic: string; summary: string; confidence: "low" | "medium" | "high"; evidence: object }> = [];
    for (const [key, platformPosts] of platforms) {
      const [platform, format] = JSON.parse(key) as [string, string];
      const tagGroups = new Map<string, ComparedPost[]>();
      for (const post of platformPosts) for (const tag of post.hashtags) {
        tagGroups.set(tag, [...(tagGroups.get(tag) ?? []), post]);
      }
      for (const [tag, cohort] of tagGroups) {
        const cohortIds = new Set(cohort.map((post) => post.content_id));
        const baseline = platformPosts.filter((post) => !cohortIds.has(post.content_id));
        if (cohort.length < MIN_POSTS_PER_COHORT || baseline.length < MIN_POSTS_PER_COHORT) continue;

        const cohortViews = median(cohort.map((post) => post.views_delta!));
        const baselineViews = median(baseline.map((post) => post.views_delta!));
        if (cohortViews === null || baselineViews === null || baselineViews <= 0) continue;
        const uplift = cohortViews / baselineViews - 1;
        if (uplift < MIN_VIEW_UPLIFT) continue;

        const cohortEngagements = median(cohort.flatMap((post) => post.engagements_delta === null ? [] : [post.engagements_delta]));
        const baselineEngagements = median(baseline.flatMap((post) => post.engagements_delta === null ? [] : [post.engagements_delta]));
        const engagementRatio = cohortEngagements !== null && baselineEngagements !== null && baselineEngagements > 0
          ? cohortEngagements / baselineEngagements : null;
        if (engagementRatio !== null && engagementRatio < MIN_RELATIVE_ENGAGEMENT) continue;

        const upliftPercent = Math.round(uplift * 100);
        const engagementText = engagementRatio === null ? " Engagement data was not sufficient for a like-for-like guardrail." :
          ` Median engagement growth was ${Math.round(engagementRatio * 100)}% of the comparison group.`;
        candidates.push({
          platform, format, topic: `#${tag}`,
          summary: `Consider testing this topic again: ${cohort.length} ${platform} ${format} posts had ${upliftPercent}% higher median 7-day view growth than ${baseline.length} comparable posts.${engagementText}`,
          confidence: recommendationConfidence(cohort.length),
          evidence: {
            snapshot_window_days: 7,
            cohort_posts: cohort.length,
            comparison_posts: baseline.length,
            median_views_growth_cohort: cohortViews,
            median_views_growth_comparison: baselineViews,
            views_growth_uplift_fraction: uplift,
            median_engagement_growth_cohort: cohortEngagements,
            median_engagement_growth_comparison: baselineEngagements,
            date_range: { from: cohort.map((post) => post.start_date).sort()[0], through: cohort.map((post) => post.end_date).sort().at(-1) },
            source_posts: cohort.slice(0, 12).map((post) => ({ url: post.url, posted_at: post.posted_at, views_growth: post.views_delta })),
          },
        });
      }
    }

    const status = withViews.length >= MIN_POSTS_PER_COHORT * 2 ? "completed" : "insufficient_history";
    const note = status === "completed"
      ? (candidates.length
        ? "Compared posts using snapshot pairs 6–8 days apart, within the same platform and format."
        : "Compared the available posts, but no hashtag pattern met the sample-size and performance thresholds.")
      : `Only ${withViews.length} post(s) have comparable view snapshots. A topic signal needs at least six matched posts: three for the hashtag cohort and three for comparison.`;
    const statements = candidates.map((item) => env.DB.prepare(
      `INSERT INTO recommendations (id, run_id, created_at, platform, format, topic, summary, confidence, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), runId, createdAt, item.platform, item.format, item.topic, item.summary, item.confidence, JSON.stringify(item.evidence)));
    for (let i = 0; i < statements.length; i += 80) await env.DB.batch(statements.slice(i, i + 80));
    await env.DB.prepare(
      "UPDATE analysis_runs SET snapshot_as_of = ?, status = ?, posts_analyzed = ?, recommendations_created = ?, note = ? WHERE id = ?",
    ).bind(snapshotAsOf, status, withViews.length, candidates.length, note, runId).run();
    return { runId, snapshotAsOf, comparedPosts: withViews.length, recommendationsCreated: candidates.length, status, note };
  } catch (error) {
    await env.DB.prepare("UPDATE analysis_runs SET note = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message.slice(0, 300) : "Analysis error", runId).run();
    throw error;
  }
}

async function importSnapshot(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) return json({ error: "Request must include an items array" }, 400);
  const raw = (body as { items: unknown[] }).items;
  if (raw.length < 1 || raw.length > MAX_IMPORT_ITEMS) return json({ error: `items must contain 1–${MAX_IMPORT_ITEMS} rows` }, 400);
  let posts: IncomingPost[];
  try { posts = raw.map(validatePost); } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid row" }, 400); }

  const unique = new Map<string, IncomingPost>();
  for (const post of posts) unique.set(`${post.platform.toLowerCase()}|${post.url}|${post.snapshot_date}`, post);
  const prepared: D1PreparedStatement[] = [];
  for (const post of unique.values()) {
    const id = await contentId(post.platform, post.url);
    const hashtags = JSON.stringify(tagsFromCaption(post.caption));
    prepared.push(env.DB.prepare(
      `INSERT INTO content_items (id, platform, url, posted_at, format, caption, hashtags_json, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, url) DO UPDATE SET posted_at = excluded.posted_at, format = excluded.format,
         caption = excluded.caption, hashtags_json = excluded.hashtags_json, last_seen = excluded.last_seen`,
    ).bind(id, post.platform, post.url, post.posted_at, post.format, post.caption, hashtags, post.snapshot_date, post.snapshot_date));
    prepared.push(env.DB.prepare(
      `INSERT INTO metric_snapshots (id, content_id, snapshot_date, views, likes, comments, shares, saves)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_id, snapshot_date) DO UPDATE SET views = excluded.views, likes = excluded.likes,
         comments = excluded.comments, shares = excluded.shares, saves = excluded.saves`,
    ).bind(crypto.randomUUID(), id, post.snapshot_date, post.views, post.likes, post.comments, post.shares, post.saves));
  }

  try {
    for (let i = 0; i < prepared.length; i += 80) await env.DB.batch(prepared.slice(i, i + 80));
    const result = await analyze(env);
    return json({ items_imported: unique.size, ...result });
  } catch {
    return json({ error: "Snapshot was received, but storage or analysis failed. Check D1 setup and Worker logs." }, 500);
  }
}

async function publicRecommendations(request: Request, env: Env): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  const run = await env.DB.prepare(
    "SELECT id, created_at, snapshot_as_of, status, posts_analyzed, recommendations_created, note FROM analysis_runs ORDER BY created_at DESC LIMIT 1",
  ).all<{ id: string; created_at: string; snapshot_as_of: string | null; status: string; posts_analyzed: number; recommendations_created: number; note: string | null }>();
  const latest = run.results?.[0] ?? null;
  if (!latest) return json({ generated_at: null, snapshot_as_of: null, status: "not_started", posts_analyzed: 0, note: "No snapshots have been imported yet.", recommendations: [] }, 200, corsHeaders(request, env));
  const recs = await env.DB.prepare(
    `SELECT platform, format, topic, summary, confidence, evidence_json, created_at
     FROM recommendations WHERE run_id = ?
     ORDER BY CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC, topic LIMIT 20`,
  ).bind(latest.id).all();
  return json({
    generated_at: latest.created_at,
    snapshot_as_of: latest.snapshot_as_of,
    status: latest.status,
    posts_analyzed: latest.posts_analyzed,
    note: latest.note,
    recommendations: recs.results ?? [],
  }, 200, corsHeaders(request, env));
}

const SALES_TYPES = new Set(["client", "lead", "prospect"]);
const SALES_STAGES = new Set(["Discovered", "Qualified", "Contact Identified", "Outreach Sent", "Conversation Started", "Meeting Scheduled", "Proposal Sent", "Negotiation", "Closed Won", "Closed Lost", "Nurture"]);
function salesObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
  const record = value as Record<string, unknown>;
  if (JSON.stringify(record).length > 30_000) throw new Error("record must be under 30 KB");
  return record;
}
function salesString(value: unknown, fallback = "", max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}
function salesNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 100_000_000) : fallback;
}
function salesDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return dateOnly(value, "date");
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
async function salesRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: salesCors(request, env) });
  if (!authorized(request, env.SALES_API_TOKEN)) return json({ error: "Unauthorized" }, 401, salesCors(request, env));
  const path = url.pathname.replace(/\/+$/, "");
  try {
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
    if (request.method === "OPTIONS" && url.pathname === "/v1/recommendations") {
      if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method === "GET" && url.pathname === "/v1/recommendations") return publicRecommendations(request, env);
    if (url.pathname === "/v1/sales/records" || url.pathname.startsWith("/v1/sales/records/") || url.pathname === "/v1/sales/activities") return salesRoute(request, env, url);
    if (!authorized(request, env.AGENT_TOKEN)) return json({ error: "Unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/v1/import") return importSnapshot(request, env);
    if (request.method === "POST" && url.pathname === "/v1/analyze") {
      try { return json(await analyze(env)); }
      catch { return json({ error: "Analysis failed; check Worker logs" }, 500); }
    }
    return json({ error: "Not found" }, 404);
  },
};
