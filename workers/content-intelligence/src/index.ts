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
interface R2Object { size: number; httpEtag: string }
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}
interface Env {
  DB: D1Database;
  CLIP_FILES: R2Bucket;
  AGENT_TOKEN?: string;
  CLIP_STRATEGIST_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
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
const MAX_ACTIVE_CLIP_JOBS = 5;
const MAX_CLIP_FILE_BYTES = 2_000_000_000;
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

function clipCorsHeaders(request: Request, env: Env): HeadersInit {
  if (!originMatches(request, env)) return {};
  return {
    "Access-Control-Allow-Origin": env.PUBLIC_READ_ORIGIN!,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function presignedR2Url(env: Env, objectKey: string, method: "GET" | "PUT"): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("R2 upload signing is not configured");
  }
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${encodeRfc3986(env.R2_BUCKET_NAME)}/${objectKey.split("/").map(encodeRfc3986).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const credential = `${env.R2_ACCESS_KEY_ID}/${scope}`;
  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", method === "PUT" ? "3600" : "900"],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalQuery = params.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).sort().join("&");
  const canonicalRequest = `${method}\n${path}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)))}`;
  const kDate = await hmac(new TextEncoder().encode(`AWS4${env.R2_SECRET_ACCESS_KEY}`), date);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function clipAuthorized(request: Request, token: string | undefined): boolean {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${token}`;
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function createClipJob(request: Request, env: Env): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid job details" }, 400);
  const row = body as Record<string, unknown>;
  let title: string, filename: string;
  try {
    title = normalizedLabel(row.title, "title", 120);
    filename = normalizedLabel(row.filename, "filename", 200);
  } catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid title or filename" }, 400); }
  const contentType = typeof row.content_type === "string" ? row.content_type.toLowerCase() : "";
  const fileSize = row.file_size_bytes;
  if (!/^video\/(mp4|mov|webm)$/.test(contentType)) return json({ error: "Use an MP4, MOV, M4V, or WebM video file" }, 400);
  if (typeof fileSize !== "number" || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > MAX_CLIP_FILE_BYTES) return json({ error: "Video must be between 1 byte and 2 GB" }, 400);
  const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM clip_jobs WHERE status != 'deleted'").all<{ count: number }>();
  if ((active.results?.[0]?.count ?? 0) >= MAX_ACTIVE_CLIP_JOBS) return json({ error: "Delete an old video job before adding another. The private workspace is limited to five active videos." }, 409);
  const id = crypto.randomUUID();
  const objectKey = `source/${id}`;
  const now = new Date().toISOString();
  try {
    const uploadUrl = await presignedR2Url(env, objectKey, "PUT");
    await env.DB.prepare(
      `INSERT INTO clip_jobs (id, title, original_filename, object_key, mime_type, file_size_bytes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
    ).bind(id, title, filename, objectKey, contentType, fileSize, now, now).run();
    return json({ id, upload_url: uploadUrl, upload_expires_in_seconds: 3600 }, 201, clipCorsHeaders(request, env));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not create upload" }, 503);
  }
}

async function completeClipUpload(request: Request, env: Env, id: string): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  const job = await env.DB.prepare("SELECT id, object_key, file_size_bytes, status FROM clip_jobs WHERE id = ?")
    .bind(id).all<{ id: string; object_key: string; file_size_bytes: number; status: string }>();
  const current = job.results?.[0];
  if (!current) return json({ error: "Clip job not found" }, 404);
  if (current.status !== "uploading") return json({ error: "This upload is not awaiting completion" }, 409);
  const object = await env.CLIP_FILES.head(current.object_key);
  if (!object) return json({ error: "Uploaded video was not found in private storage" }, 400);
  if (object.size !== current.file_size_bytes) return json({ error: "Uploaded video size did not match the original file" }, 400);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE clip_jobs SET status = 'queued', updated_at = ? WHERE id = ?").bind(now, id).run();
  return json({ id, status: "queued", message: "Video uploaded. Start the AI Clip Strategist workflow in GitHub Actions to analyze it." }, 202, clipCorsHeaders(request, env));
}

async function listClipJobs(request: Request, env: Env): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  const jobs = await env.DB.prepare(
    `SELECT id, title, original_filename, mime_type, file_size_bytes, status, created_at, updated_at, processed_at, error_message, analysis_note
     FROM clip_jobs WHERE status != 'deleted' ORDER BY created_at DESC LIMIT 30`,
  ).all();
  return json({ jobs: jobs.results ?? [] }, 200, clipCorsHeaders(request, env));
}

async function deleteClipJob(request: Request, env: Env, id: string): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  const found = await env.DB.prepare("SELECT object_key FROM clip_jobs WHERE id = ?").bind(id).all<{ object_key: string }>();
  const objectKey = found.results?.[0]?.object_key;
  if (!objectKey) return json({ error: "Clip job not found" }, 404);
  await env.CLIP_FILES.delete(objectKey);
  await env.DB.prepare("DELETE FROM clip_jobs WHERE id = ?").bind(id).run();
  return json({ id, deleted: true }, 200, clipCorsHeaders(request, env));
}

async function getClipJob(request: Request, env: Env, id: string): Promise<Response> {
  if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
  const found = await env.DB.prepare(
    `SELECT id, title, original_filename, mime_type, file_size_bytes, status, created_at, updated_at, processed_at, error_message
     FROM clip_jobs WHERE id = ? AND status != 'deleted'`,
  ).bind(id).all();
  const job = found.results?.[0];
  if (!job) return json({ error: "Clip job not found" }, 404);
  const transcripts = await env.DB.prepare(
    `SELECT start_ms, end_ms, speaker_label, text, confidence, evidence_source
     FROM clip_transcript_segments WHERE job_id = ? ORDER BY start_ms`,
  ).bind(id).all();
  const candidates = await env.DB.prepare(
    `SELECT rank, start_ms, end_ms, title, hook, rationale, editorial_score, evidence_json,
            edit_plan_json, platform_adaptations_json, confidence, model_provenance_json
     FROM clip_candidates WHERE job_id = ? ORDER BY rank`,
  ).bind(id).all<Record<string, unknown>>();
  const parsedCandidates = (candidates.results ?? []).map((row) => {
    const parse = (key: string) => { try { return JSON.parse(String(row[key] ?? "{}")); } catch { return {}; } };
    return { ...row, evidence: parse("evidence_json"), edit_plan: parse("edit_plan_json"), platform_adaptations: parse("platform_adaptations_json"), model_provenance: parse("model_provenance_json") };
  });
  return json({ job, transcript_segments: transcripts.results ?? [], candidates: parsedCandidates }, 200, clipCorsHeaders(request, env));
}

async function claimNextClipJob(env: Env): Promise<Response> {
  const found = await env.DB.prepare(
    `SELECT id, title, original_filename, object_key, mime_type, file_size_bytes
     FROM clip_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
  ).all<{ id: string; title: string; original_filename: string; object_key: string; mime_type: string; file_size_bytes: number }>();
  const job = found.results?.[0];
  if (!job) return json({ job: null });
  const now = new Date().toISOString();
  const claim = await env.DB.prepare("UPDATE clip_jobs SET status = 'processing', updated_at = ?, error_message = NULL WHERE id = ? AND status = 'queued'")
    .bind(now, job.id).run();
  if (claim && typeof claim === "object" && "meta" in claim) {
    const changes = Number((claim as { meta?: { changes?: number } }).meta?.changes ?? 0);
    if (changes === 0) return json({ job: null });
  }
  try {
    const downloadUrl = await presignedR2Url(env, job.object_key, "GET");
    return json({ job: { id: job.id, title: job.title, filename: job.original_filename, mime_type: job.mime_type, file_size_bytes: job.file_size_bytes }, download_url: downloadUrl, download_expires_in_seconds: 900 });
  } catch {
    await env.DB.prepare("UPDATE clip_jobs SET status = 'failed', updated_at = ?, error_message = ? WHERE id = ?")
      .bind(new Date().toISOString(), "Private storage download could not be prepared.", job.id).run();
    return json({ error: "Could not prepare video for processing" }, 503);
  }
}

function jsonObject(value: unknown, field: string, maximum = 20_000): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const serialized = JSON.stringify(value);
  if (serialized.length > maximum) throw new Error(`${field} is too large`);
  return serialized;
}

async function saveClipResults(request: Request, env: Env, id: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid analysis result" }, 400);
  const row = body as Record<string, unknown>;
  const duration = row.duration_ms;
  const rawSegments = row.transcript_segments;
  const rawCandidates = row.candidates;
  if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 1 || duration > 7_200_000) return json({ error: "duration_ms must be between 1 ms and 2 hours" }, 400);
  if (!Array.isArray(rawSegments) || rawSegments.length > 20_000) return json({ error: "transcript_segments must be an array with at most 20,000 entries" }, 400);
  if (!Array.isArray(rawCandidates) || rawCandidates.length > 10) return json({ error: "candidates must be an array with at most 10 entries" }, 400);
  let provenance: string;
  const analysisNote = typeof row.analysis_note === "string" ? row.analysis_note.trim().slice(0, 1_000) : "";
  try { provenance = jsonObject(row.model_provenance, "model_provenance"); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid model provenance" }, 400); }
  try {
    const exists = await env.DB.prepare("SELECT status FROM clip_jobs WHERE id = ?").bind(id).all<{ status: string }>();
    if (!exists.results?.length) return json({ error: "Clip job not found" }, 404);
    const transcriptRows = rawSegments.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Transcript segment ${index + 1} must be an object`);
      const segment = item as Record<string, unknown>;
      const start = segment.start_ms, end = segment.end_ms;
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || typeof end !== "number" || !Number.isSafeInteger(end) || end <= start || end > duration) throw new Error(`Transcript segment ${index + 1} has invalid timestamps`);
      const text = normalizedLabel(segment.text, "transcript text", 2_000);
      const speaker = segment.speaker_label == null ? null : normalizedLabel(segment.speaker_label, "speaker_label", 80);
      const confidence = segment.confidence == null ? null : segment.confidence;
      if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new Error(`Transcript segment ${index + 1} has invalid confidence`);
      const source = typeof segment.evidence_source === "string" ? segment.evidence_source.slice(0, 40) : "speech_to_text";
      return env.DB.prepare(
        `INSERT INTO clip_transcript_segments (id, job_id, start_ms, end_ms, speaker_label, text, confidence, evidence_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), id, start, end, speaker, text, confidence, source);
    });
    const candidateRows = rawCandidates.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Candidate ${index + 1} must be an object`);
      const candidate = item as Record<string, unknown>;
      const start = candidate.start_ms, end = candidate.end_ms, score = candidate.editorial_score;
      if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 || typeof end !== "number" || !Number.isSafeInteger(end) || end <= start || end > duration || end - start > 180_000) throw new Error(`Candidate ${index + 1} has invalid source timestamps or exceeds 180 seconds`);
      if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) throw new Error(`Candidate ${index + 1} editorial_score must be 0–100`);
      const confidence = candidate.confidence;
      if (confidence !== "low" && confidence !== "medium" && confidence !== "high") throw new Error(`Candidate ${index + 1} confidence is invalid`);
      const rank = index + 1;
      return env.DB.prepare(
        `INSERT INTO clip_candidates (id, job_id, rank, start_ms, end_ms, title, hook, rationale, editorial_score,
          evidence_json, edit_plan_json, platform_adaptations_json, confidence, model_provenance_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), id, rank, start, end,
        normalizedLabel(candidate.title, "candidate title", 140), normalizedLabel(candidate.hook, "opening hook", 500),
        normalizedLabel(candidate.rationale, "rationale", 1_000), score,
        jsonObject(candidate.evidence, "evidence"), jsonObject(candidate.edit_plan, "edit_plan"),
        jsonObject(candidate.platform_adaptations, "platform_adaptations"), confidence, provenance, new Date().toISOString());
    });
    const clear = [
      env.DB.prepare("DELETE FROM clip_transcript_segments WHERE job_id = ?").bind(id),
      env.DB.prepare("DELETE FROM clip_candidates WHERE job_id = ?").bind(id),
    ];
    await env.DB.batch(clear);
    for (let i = 0; i < transcriptRows.length; i += 80) await env.DB.batch(transcriptRows.slice(i, i + 80));
    for (let i = 0; i < candidateRows.length; i += 80) await env.DB.batch(candidateRows.slice(i, i + 80));
    const processedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE clip_jobs SET status = 'completed', updated_at = ?, processed_at = ?, error_message = NULL, analysis_note = ? WHERE id = ?")
      .bind(processedAt, processedAt, analysisNote, id).run();
    return json({ id, status: "completed", transcript_segments: transcriptRows.length, candidates: candidateRows.length });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not save analysis results" }, 400);
  }
}

async function failClipJob(request: Request, env: Env, id: string): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "Request body must be valid JSON" }, 400); }
  const message = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).error === "string"
    ? ((body as Record<string, string>).error).slice(0, 500) : "Processing failed; review the workflow logs.";
  await env.DB.prepare("UPDATE clip_jobs SET status = 'failed', updated_at = ?, error_message = ? WHERE id = ?")
    .bind(new Date().toISOString(), message, id).run();
  return json({ id, status: "failed" });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    const isClipRoute = url.pathname === "/v1/clip-jobs" || url.pathname === "/v1/clip-jobs/next" || /^\/v1\/clip-jobs\/[0-9a-f-]+(?:\/(?:complete|results|fail))?$/i.test(url.pathname);
    if (isClipRoute && request.method === "OPTIONS") {
      if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
      return new Response(null, { status: 204, headers: clipCorsHeaders(request, env) });
    }
    if (isClipRoute) {
      const jobId = url.pathname.split("/")[3] ?? "";
      const runnerRoute = url.pathname === "/v1/clip-jobs/next" || /\/results$|\/fail$/.test(url.pathname);
      let response: Response;
      if (runnerRoute) {
        if (!authorized(request, env.AGENT_TOKEN)) response = json({ error: "Unauthorized" }, 401);
        else if (request.method === "POST" && url.pathname === "/v1/clip-jobs/next") response = await claimNextClipJob(env);
        else if (request.method === "POST" && url.pathname.endsWith("/results")) response = await saveClipResults(request, env, jobId);
        else if (request.method === "POST" && url.pathname.endsWith("/fail")) response = await failClipJob(request, env, jobId);
        else response = json({ error: "Not found" }, 404);
      } else if (!clipAuthorized(request, env.CLIP_STRATEGIST_TOKEN)) response = json({ error: "Unauthorized" }, 401);
      else if (request.method === "POST" && url.pathname === "/v1/clip-jobs") response = await createClipJob(request, env);
      else if (request.method === "GET" && url.pathname === "/v1/clip-jobs") response = await listClipJobs(request, env);
      else if (request.method === "POST" && /^\/v1\/clip-jobs\/[0-9a-f-]+\/complete$/i.test(url.pathname)) response = await completeClipUpload(request, env, jobId);
      else if (request.method === "GET" && /^\/v1\/clip-jobs\/[0-9a-f-]+$/i.test(url.pathname)) response = await getClipJob(request, env, jobId);
      else if (request.method === "DELETE" && /^\/v1\/clip-jobs\/[0-9a-f-]+$/i.test(url.pathname)) response = await deleteClipJob(request, env, jobId);
      else response = json({ error: "Not found" }, 404);
      const headers = new Headers(response.headers);
      new Headers(clipCorsHeaders(request, env)).forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (request.method === "OPTIONS" && url.pathname === "/v1/recommendations") {
      if (!originMatches(request, env)) return json({ error: "Origin not allowed" }, 403);
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method === "GET" && url.pathname === "/v1/recommendations") return publicRecommendations(request, env);
    if (!authorized(request, env.AGENT_TOKEN)) return json({ error: "Unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/v1/import") return importSnapshot(request, env);
    if (request.method === "POST" && url.pathname === "/v1/analyze") {
      try { return json(await analyze(env)); }
      catch { return json({ error: "Analysis failed; check Worker logs" }, 500); }
    }
    return json({ error: "Not found" }, 404);
  },
};
