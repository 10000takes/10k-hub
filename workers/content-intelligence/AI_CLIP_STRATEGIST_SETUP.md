# AI Clip Strategist: MVP and Setup

## What It Does

The Content Intelligence tab accepts an original video file and creates a private job. The team manually starts a GitHub Actions workflow to process one queued video. The workflow returns a speaker-labeled, word-timestamped transcript where the provider can identify speakers, plus up to ten ranked clip candidates. Each candidate includes source timecodes, quoted transcript and observed visual/audio evidence, separate editorial hypotheses, confidence, a Final Cut Pro edit plan, and platform-specific adaptation notes.

It does not create finished edits or publish. Scores are editorial priority rankings, not probabilities. The model is instructed to distinguish observations from hypotheses and reject timestamps outside the source duration. Fast motion can be missed; Gemini's standard video analysis samples at about one frame per second, so quick reactions or action may require an editor to verify in the original.

## Current Scope And Follow-On Work

Included in this first build:

- Upload MP4, MOV, M4V, or WebM files up to 2 GB from the browser directly to private R2 storage.
- Keep job metadata, transcript, candidate evidence, and edit notes in the existing Content Intelligence D1 database.
- Process a single queued video per manual workflow run. Processing is not scheduled and does not run automatically after upload.
- Show transcript and expandable candidate details on the Content Intelligence tab.
- Delete the source file and analysis record from the dashboard.
- Delete temporary Gemini Files API uploads after each workflow attempt; the Gemini Files API also automatically deletes files after 48 hours.

Not included yet:

- Public YouTube URL ingestion. Upload an original local file for the initial MVP. Supporting YouTube source links needs a separate source-access decision; no scraping/downloader is included.
- Verified current trend feeds or trend-based editing recommendations.
- Using historical 10K Hub performance to rank candidates.
- A dashboard form to mark a candidate as published and attach its eventual metrics. The schema includes a publication-feedback table for a later phase; there is no API/UI for it yet.
- Automatic editing, Final Cut Pro project generation, or publishing.

## Architecture

1. The dashboard creates a job through the Content Intelligence Worker. Its access token is held only in the current browser session.
2. The Worker returns a short-lived signed R2 upload URL. The browser uploads video bytes directly to a private R2 bucket; the video does not pass through GitHub Pages or D1.
3. After upload, the Worker verifies object size and queues the job.
4. A human starts **AI Clip Strategist** in GitHub Actions. The action downloads one queued video to temporary runner storage, splits its audio into 24-minute chunks with FFmpeg, asks Gemini 3.5 Transcribe for diarized word timestamps on each chunk, and asks Gemini 3.8 Flash to inspect the video in agentic mode and prepare structured clip recommendations. Agentic mode navigates the long video selectively; Gemini interactions run in the background and the runner polls for completion to avoid ordinary request timeouts.
5. The runner sends transcript and recommendations to the authenticated Worker. The Worker stores only analysis data in D1. The runner removes Gemini temporary uploads and its temporary working directory at the end of the run.
6. The dashboard fetches private results using the session token. No API or automatic publishing step exists.

## First-Time Setup (After Reviewing And Pushing The Code)

These are setup actions for the repository owner; no cloud resource, secret, or deployment is created by the code changes themselves.

1. Create a private R2 bucket named `10k-takes-clip-strategist` in the same Cloudflare account as the Content Intelligence Worker. Do not enable public access or attach a public custom domain.
2. Configure bucket CORS for the GitHub Pages origin `https://10000takes.github.io`, methods `PUT`, `GET`, and `HEAD`, and allowed request header `Content-Type`. Browser uploads using presigned URLs require bucket CORS.
3. Create an R2 API token scoped to this bucket with object read/write permissions. In `workers/content-intelligence`, set the existing Worker's secrets:

   ```sh
   npx wrangler secret put CLIP_STRATEGIST_TOKEN
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

   Use a new random `CLIP_STRATEGIST_TOKEN` of at least 32 characters. Enter the R2 access key ID and secret access key from the scoped R2 token when prompted. Set `R2_ACCOUNT_ID` as a non-secret Worker variable if it is not already available in the account configuration.

   In the Cloudflare dashboard, add `R2_ACCOUNT_ID` under the Content Intelligence Worker’s Settings → Variables and Secrets as a plain-text variable. The bucket name is already declared in `wrangler.jsonc`.

4. Apply the new D1 migration from the same Worker directory:

   ```sh
   npx wrangler d1 execute 10k-takes-content-intelligence --remote --file=migrations/0002_clip_strategist.sql
   ```

5. Create a Gemini API key with paid-tier billing for private company footage. Add it as the GitHub repository **Actions secret** `GEMINI_API_KEY`.
6. Check the GitHub repository already has Actions variable `CONTENT_INTELLIGENCE_API_URL` and Actions secret `CONTENT_INTELLIGENCE_TOKEN`, matching the Worker URL and `AGENT_TOKEN`. Those existing names are reused; no second runner token is needed.
7. Deploy the Content Intelligence Worker from its directory only after the R2 bucket and secrets are ready. Then deploy the GitHub Pages dashboard so the upload UI is available. Adding the R2 binding before creating the bucket will make Worker deployment fail.
8. In the Content Intelligence tab, enter the Worker URL and `CLIP_STRATEGIST_TOKEN`, connect, upload one short test video, and inspect the queued job. Open Actions → **AI Clip Strategist** → **Run workflow** to process it. Each manual run processes at most one video.

If a Worker secret name already exists, `wrangler secret put NAME` updates that secret. Never put these values in `wrangler.jsonc`, GitHub variables, a CSV, or the dashboard source.

## Budget And Data Handling

The workflow is manual and one-video-at-a-time, so upload alone does not invoke paid AI. The current published Gemini pricing estimates transcription at about **$0.005 per minute of source audio** (roughly $0.10–$0.20 for 20–40 minutes); multimodal analysis cost varies with video navigation, audio/video processing, prompt size, and output, so there is no reliable fixed per-video quote. Gemini says agentic mode can use up to 88% fewer tokens than static processing for long-form video, but actual savings and quality vary. Check usage in Google AI Studio after the first run and set billing alerts before processing a backlog. The model is configurable with `CLIP_VIDEO_MODEL`; changing it changes cost and output behavior. Speaker diarization and word-level timestamp features are limited to 30 minutes per transcription request, so audio is split into 24-minute chunks; speaker labels may restart between chunks and do not identify real people.

Use the paid Gemini API tier for this private material. Google's pricing page states paid-tier API content is not used to improve its products, while free-tier data may be. Gemini Files API uploads are temporary and automatically deleted after 48 hours; this workflow also attempts immediate deletion. The original source stays in the private R2 bucket until the job is deleted from the dashboard. R2 storage and Worker/D1 usage can incur separate account charges. The five-job limit is a storage/housekeeping guard, not a spend cap.

Official references: [Gemini transcription](https://ai.google.dev/gemini-api/docs/transcribe), [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini Files API](https://ai.google.dev/gemini-api/docs/files), [Cloudflare R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/), and [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## Data Model

- `clip_jobs`: title, original filename, private R2 object key, size, status, timestamps, and processing error/note.
- `clip_transcript_segments`: start/end milliseconds, diarization label, recognized text, and evidence source. A label like `Speaker 1` is not a verified identity.
- `clip_candidates`: rank, source range, title, opening hook, rationale, editorial score, confidence, evidence JSON, edit plan, platform adaptations, and model provenance.
- `clip_publications`: reserved for later capture of published URLs and post metrics; it is not wired into the UI in this MVP.

The dashboard currently allows five jobs total, including failed and completed jobs. Delete jobs and their source videos when they are no longer needed. A failed workflow can be reviewed in Actions; a failed job must be deleted and uploaded again to retry in this first version.
