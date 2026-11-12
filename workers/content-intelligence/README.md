# Content Intelligence Worker

Cloudflare Worker + D1 backend for the 10K Takes dashboard's Content Intelligence panel.

## Data flow

1. The dashboard's existing GitHub Action refreshes `top_posts.csv` daily from the configured platform APIs.
2. A separate, opt-in GitHub Action reads that CSV and posts a snapshot to this Worker. It is disabled until the repository variable `CONTENT_INTELLIGENCE_ENABLED` is set to `true`.
3. The Worker saves daily cumulative counters in D1 and analyzes week-over-week changes. It needs at least two snapshots roughly a week apart before it can compare a post.
4. The dashboard fetches public, read-only recommendation summaries from the Worker. It never receives the write token.

The current collector uses a rolling 30-day set of posts. D1 preserves each daily snapshot after a post rolls out of that CSV, so older posts' captured history remains available for analysis.

## What the first agent measures

- Seven-day view and engagement changes per post, using cumulative counters captured about 6–8 days apart.
- Comparisons are limited to the same platform and post format; platform view definitions are not compared with each other.
- Topic signals use hashtags already present in the collected caption. Each signal needs at least three posts with comparable snapshots and at least three comparison posts (six matched posts total).
- A signal is suggested when median seven-day view growth is at least 25% higher than the matching baseline and engagement growth is not more than 20% lower, when both engagement series are available.
- Recommendations are drafts for a person to consider. Nothing is published or sent.

These thresholds are starting rules, not proven 10K Takes targets. The dashboard indicates when the history is too short to produce a comparison. Hashtags are only a rough topic label; content meaning and causal explanations are not inferred in this version.

## Dashboard analysis tools and data coverage

The Content Intelligence page now includes a date-selectable daily post review, a single-post evidence view, a browser-local experiment log, and a constrained evidence finder. These use `top_posts.csv`, which is refreshed daily and contains a rolling 30-day set of owned posts. Comparisons use lifetime views divided by post age and the median of same-platform/same-format posts when available; the dashboard falls back to a same-platform median for small format samples. This is a directional age-normalized proxy, not an age-matched distribution curve. Posts younger than seven days are not called underperformers. Findings show sample size and confidence, and explanations are labeled as creative clues or alternative hypotheses rather than causes.

The existing morning opportunity email now includes a short performance summary for the most recent publish date represented in `top_posts.csv`, alongside its source-linked Minnesota story opportunities. It does not send an email from this code-editing session; the existing scheduled GitHub Action controls delivery and still requires its existing Resend secrets.

| Platform | Currently collected post metrics | Creative/context fields | Not currently collected across the account |
| --- | --- | --- | --- |
| Instagram | Views, likes, comments, shares, saves where the authorized API returns them | URL, publish time, media type, caption | Retention curve, watch time, traffic sources, follower conversions, downloaded media or thumbnails |
| Facebook | Per-post views where Page Insights returns them; reactions, comments, and shares on eligible Page posts | URL, publish time, post type, caption | Complete in-app engagement for all post types, retention, watch time, traffic sources, follower conversions |
| TikTok | Views, likes, comments, shares from the connected account API | URL, publish time, post type/description, duration when returned | Watch-time/retention distribution, traffic sources, follower conversions, video assets/transcripts |
| X | Impressions, likes, replies, reposts/quotes, bookmarks where returned by the configured API | URL, publish time, text, post type | Watch time/retention, traffic sources, follower conversions, video assets/transcripts |
| YouTube | Views, likes, comments from the Data API | URL, publish time, title/caption, video type and duration | Watch time, retention, traffic sources, and subscriber conversions require the separate YouTube Analytics integration |

The published feed does not contain raw media files or thumbnails. Competitor monitoring is currently limited to eligible public Instagram Business/Creator accounts through Meta Business Discovery; it exposes interactions and follower counts but not competitor reach or views. The news opportunity scan uses Google News RSS and should not be mistaken for live trend counts on Instagram, Facebook, TikTok, or X.

The experiment log and evidence finder are intentionally browser-local and deterministic. Experiments compare same-platform/format posts before and after the test date when sufficient collected examples exist, but this remains observational and is not a randomized causal test. The evidence finder retrieves and ranks matching collected posts; it is not a generative AI analyst. AI Clip Strategist now provides an opt-in multimodal video workflow; it does not edit or publish, and current trend feeds and 10K Hub historical comparisons are not connected to that workflow. See [AI Clip Strategist setup](AI_CLIP_STRATEGIST_SETUP.md) before provisioning storage or provider credentials.

### Requirement status and next phases

| Spec item | Current state | What is still needed |
| --- | --- | --- |
| Daily performance review and winners/underperformers | Date-selectable review over the latest collected posts; small samples and posts younger than seven days are handled conservatively | Longer age-matched cohorts and better historical post coverage |
| Platform-specific performance and post analysis | Platform and format medians, source post links, and measured fields | Improve baseline quality with more history; unavailable metrics remain excluded |
| Historical insights | Existing Worker stores daily snapshots and reports supported hashtag comparisons; dashboard shows its current rolling post window | Public Worker endpoint currently returns only its latest recommendation set, not an interactive long-range query API |
| Trends and opportunity ideas | Google News RSS for Minnesota teams plus the Instagram Business Discovery collector and existing account directory | Live trend measurements for Instagram, Facebook, TikTok, and X need eligible official APIs or another authorized data provider; RSS/news counts are not social trends |
| Content experiments | Browser-local hypotheses and notes, plus before/after same-format view-rate comparison when sample exists | Shared durable experiment records and stronger causal designs require a private write path and more samples |
| Ask the analyst | Deterministic retrieval and ranking from currently loaded post records | Natural-language generative answers require an approved model/provider and a server-side, evidence-grounded retrieval path |
| Video creative analysis | Private upload, timestamped diarized transcript, multimodal shortlist, evidence and Final Cut Pro edit guidance | Trend and 10K Hub history integration; publish/performance feedback capture |

The earlier analytics and experiment changes reuse the static dashboard, existing daily collector, D1 snapshot store, and current Resend email action. AI Clip Strategist is a separate opt-in workflow that requires private R2 storage and Gemini API credentials; uploads do not trigger model processing or charges by themselves. Future phases can connect trend signals, historical 10K Hub performance, and published-clip results to the current recommendations without changing its human approval step.

## Daily opportunity radar (new)

The scheduled `Content Intelligence snapshot` workflow also runs `scripts/generate_content_opportunities.py`. It:

- Searches Google News RSS daily for the Vikings, Twins, Timberwolves, Lynx, Wild, Gophers, Minnesota United, and Minnesota Frost.
- Can include any HTTPS RSS feeds listed in the `accounts` array in `config/monitored_sources.json` (for example, a creator's public YouTube channel feed), or a name plus a Google News query for public/indexed mentions. Add a `category` to separate groups, e.g. `{"name":"Rival Page","platform":"Instagram","search_query":"\"@handle\" Minnesota sports","team":"Twins","category":"Competing pages"}` and `{"name":"Sports Creator","platform":"TikTok","feed_url":"https://example.com/public-feed.xml","team":"Vikings","category":"Sports creators"}`. The opportunity dashboard groups report items under **All** and adds one filter per category. The accounts array remains empty until supported feeds/searches are configured. Search-query matching is indirect and does not guarantee every social post from the account is captured.
- The workbook-supplied Instagram and TikTok competitor list is stored under `competitors` in the same config. The dashboard displays a separate public profile directory, grouped by category, with **All** and category filters. This directory is a curated reference list; it does not connect to or directly monitor those social accounts. For actual post monitoring, use authorized account/platform APIs or supported public RSS feeds. Search-query matching is indirect and does not guarantee every social post from an account is captured.
- Scores each current story from 0–100 using relevance (35%), timeliness (30%), virality cues and publisher corroboration (20%), and execution ease (15%). The dimensions are transparent heuristics, not a model prediction.
- Suggests a format, a draft hook, and adaptation ideas for Instagram, Facebook, TikTok, and X. The hook must be checked against its linked source before use.
- Publishes `content-opportunities.json` for the GitHub Pages dashboard and can email the top eight ideas through Resend.

The report does **not** claim to have live trending-post counts from Instagram, Facebook, TikTok, or X. TikTok Creative Center exposes a free public trends interface, but its Research API is for approved research use. Meta's broad Content Library is for qualified research applicants. X offers usage-based API access, so reading posts can add cost. To keep the first pass inside the $0–$50 budget and avoid scraping or unofficial access, the opportunity radar uses news/RSS plus 10K Takes' own post history, and labels platform trend feeds as disconnected or manual. Competitor-post monitoring is a separate opt-in feature described below.

### Competitor post monitoring

The dashboard has a public-post intelligence panel alongside the categorized directory. When populated, it shows recent post links/captions, format, likes/comments, follower count, caption-opening and topic labels, account-relative interaction rates, and cautious adaptation ideas. Instagram is collected only through the official Business Discovery API for eligible public Business/Creator profiles. Competitor reach, retention, and private Insights are not exposed. TikTok and Facebook remain labeled unavailable until a compliant access path is approved; this collector does not scrape social sites.

The collector is opt-in and makes no Meta API requests unless the repository Actions variable `COMPETITOR_INTELLIGENCE_ENABLED` is set to `true`. It uses `INSTAGRAM_ACCOUNT_ID` and a dedicated `INSTAGRAM_DISCOVERY_TOKEN` Actions secret (a Facebook user access token with the required Instagram permissions; do not reuse a token unless Meta confirms it is suitable). It calls Instagram Business Discovery once per listed Instagram handle (currently about 41 requests per daily run). Meta must grant the app the permissions/features needed for Instagram Graph API access, the connected 10K Takes account must be eligible, and each target must be a public Business/Creator account. A failed or ineligible handle is recorded as unavailable; other accounts continue.

To activate it later, first confirm the app/token meets Meta's current requirements and add the token as the `INSTAGRAM_DISCOVERY_TOKEN` Actions secret. Then set `COMPETITOR_INTELLIGENCE_ENABLED=true` under repository Settings → Secrets and variables → Actions → Variables and manually run **Content Intelligence snapshot** once. That setting is the explicit switch for recurring external requests. Do not add a token to the dashboard or a normal repository variable. If Meta access is not approved, leave the switch off; the dashboard still shows the curated directory and explains that post monitoring is pending.

Posts are ranked by public likes and comments per follower relative to each account's own recent-post median (at least five sampled posts are needed for an above-baseline flag). Raw engagement totals are not compared across accounts. Adaptation suggestions require repeated topic/hook/format signals and remain editorial prompts, not causal claims. `competitor-intelligence.json` is published with GitHub Pages and is public. The supplied list currently has 41 Instagram accounts and 5 TikTok accounts. TikTok collection is not included because ordinary Display API access requires each creator's authorization, while Research Tools exclude commercial users. Facebook collection remains off pending Page Public Content Access approval.

### Turn on the daily email

Email is intentionally inactive until the repository has these three **Actions secrets**:

- `RESEND_API_KEY` — an API key from Resend.
- `OPPORTUNITIES_EMAIL_TO` — the recipient address.
- `RESEND_FROM` — a sender address on a domain verified in Resend (for example, `10K Takes <insights@your-verified-domain>`).

The Resend free tier currently lists 3,000 emails/month and 100/day. One daily email is within that limit. This code does not create a Resend account, verify a domain, add payment details, or send email until the secrets are set. The email uses an idempotency key to prevent a same-day rerun from sending duplicates.

The workflow writes the daily JSON report back to `main`, so `contents: write` must be allowed for GitHub Actions in repository settings. It is scheduled at 12:30 UTC (06:30 Central during standard time and 07:30 during daylight time); GitHub may start scheduled runs later than the exact minute.

### Scoring and safety

- **Relevance:** direct team/topic matches from the source title.
- **Timeliness:** an exponential time decay, with a 36-hour half-life.
- **Virality potential:** emotional/high-interest story cues plus distinct publisher corroboration; this is only a proxy, not observed social reach.
- **Ease:** favors quick reaction/explainer formats; own post history is noted but does not claim a causal format lift.
- Articles older than four days are excluded. Each suggestion includes its source and a reminder to verify current facts. Hooks are drafts and are not published automatically.
- Public account feed links and report content are part of the GitHub Pages site. Do not put private notes, credentials, or confidential competitor data in this feed.

## Provision D1

From this directory, create the database and apply its schema:

```sh
npm install
npx wrangler d1 create 10k-takes-content-intelligence
npx wrangler d1 execute 10k-takes-content-intelligence --remote --file=schema.sql
```

Copy the returned database ID into `wrangler.jsonc`. Set the dashboard's exact **origin** (scheme + host, no path) as `PUBLIC_READ_ORIGIN`, for example `https://10000takes.github.io`. Keep `AGENT_TOKEN` as a Worker secret, never a normal variable:

```sh
npx wrangler secret put AGENT_TOKEN
npx wrangler deploy
```

Use a long random token (at least 32 characters). The secret is only used by the GitHub Action that imports snapshots. No token belongs in `index.html`, dashboard storage, or the repository.

## Enable the daily import

In GitHub repository Settings → Secrets and variables → Actions:

- Add variable `CONTENT_INTELLIGENCE_ENABLED` with value `true` only after the Worker is deployed and configured.
- Add variable `CONTENT_INTELLIGENCE_API_URL` with the Worker base URL, e.g. `https://10k-takes-content-intelligence.<your-subdomain>.workers.dev`.
- Add secret `CONTENT_INTELLIGENCE_TOKEN` with the same value as Worker secret `AGENT_TOKEN`.

Then run the `Content Intelligence snapshot` workflow once manually from the Actions tab. It also runs daily after the existing collector's scheduled refresh. Turning the enable variable off disables imports.

## Dashboard

In the dashboard's **Content Intelligence** tab, enter the Worker base URL and select **Connect**. The URL is saved only in that browser. Reads are public and read-only, restricted by CORS to `PUBLIC_READ_ORIGIN`; CORS is not authentication. This is appropriate only because the current GitHub Pages dashboard already loads `top_posts.csv` publicly and the endpoint returns derived content metrics/recommendations only. Do not add sponsor contacts, revenue, credentials, or other private data to these tables or responses.

The dashboard's four-digit PIN is checked in browser JavaScript; it is a convenience screen, not server-side access control. Treat files and API data published for this dashboard as public.

## API

- `GET /health` — liveness.
- `GET /v1/recommendations` — public read-only summary when the request Origin matches `PUBLIC_READ_ORIGIN`.
- `POST /v1/import` — bearer-token-protected daily snapshot import followed by analysis.
- `POST /v1/analyze` — bearer-token-protected rerun.

Import format is generated by `scripts/upload_content_snapshot.py` from the existing `top_posts.csv`. All imports are idempotent for the same post and snapshot date.
