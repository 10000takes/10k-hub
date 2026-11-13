#!/usr/bin/env python3
"""Process one queued AI Clip Strategist job using paid Gemini APIs."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_VIDEO_BYTES = 2_000_000_000
MAX_ANALYSIS_SECONDS = 7200
TRANSCRIPTION_CHUNK_SECONDS = 24 * 60
MODEL_VIDEO = os.getenv("CLIP_VIDEO_MODEL", "gemini-3.8-flash")
MODEL_TRANSCRIBE = "gemini-3.5-transcribe"

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "analysis_note": {"type": "string"},
        "candidates": {
            "type": "array",
            "maxItems": 10,
            "items": {
                "type": "object",
                "properties": {
                    "start_ms": {"type": "integer"},
                    "end_ms": {"type": "integer"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "rationale": {"type": "string"},
                    "editorial_score": {"type": "integer"},
                    "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                    "evidence": {
                        "type": "object",
                        "properties": {
                            "transcript_quotes": {"type": "array", "items": {"type": "object", "properties": {"start_ms": {"type": "integer"}, "end_ms": {"type": "integer"}, "speaker": {"type": "string"}, "quote": {"type": "string"}}, "required": ["start_ms", "end_ms", "speaker", "quote"]}},
                            "visual_moments": {"type": "array", "items": {"type": "object", "properties": {"time_ms": {"type": "integer"}, "observation": {"type": "string"}, "signal": {"type": "string"}}, "required": ["time_ms", "observation", "signal"]}},
                            "audio_moments": {"type": "array", "items": {"type": "object", "properties": {"time_ms": {"type": "integer"}, "observation": {"type": "string"}}, "required": ["time_ms", "observation"]}},
                            "hypotheses": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["transcript_quotes", "visual_moments", "audio_moments", "hypotheses"],
                    },
                    "edit_plan": {
                        "type": "object",
                        "properties": {
                            "suggested_cut_in_ms": {"type": "integer"},
                            "suggested_cut_out_ms": {"type": "integer"},
                            "opening_hook": {"type": "string"},
                            "pacing": {"type": "string"},
                            "captions": {"type": "string"},
                            "on_screen_text": {"type": "string"},
                            "ending": {"type": "string"},
                            "final_cut_pro_notes": {"type": "string"},
                        },
                        "required": ["suggested_cut_in_ms", "suggested_cut_out_ms", "opening_hook", "pacing", "captions", "on_screen_text", "ending", "final_cut_pro_notes"],
                    },
                    "platform_adaptations": {
                        "type": "object",
                        "properties": {
                            "Instagram Reels": {"type": "string"},
                            "Facebook Reels": {"type": "string"},
                            "TikTok": {"type": "string"},
                            "YouTube Shorts": {"type": "string"},
                            "X": {"type": "string"},
                        },
                        "required": ["Instagram Reels", "Facebook Reels", "TikTok", "YouTube Shorts", "X"],
                    },
                },
                "required": ["start_ms", "end_ms", "title", "hook", "rationale", "editorial_score", "confidence", "evidence", "edit_plan", "platform_adaptations"],
            },
        },
    },
    "required": ["analysis_note", "candidates"],
}


def api_request(url: str, token: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    # Cloudflare applies Browser Integrity checks to workers.dev requests.
    # urllib's default Python-urllib User-Agent is blocked with error 1010,
    # so identify this automated client explicitly.
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "10K-Hub-AI-Clip-Strategist/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:1200]
        raise RuntimeError(f"Worker API returned HTTP {exc.code}: {body}") from exc


def mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True)
    if hasattr(value, "__dict__"):
        return {key: val for key, val in vars(value).items() if not key.startswith("_")}
    return {}


def seconds_to_ms(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0, round(float(value) * 1000))
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)s\s*", str(value))
    if match:
        return max(0, round(float(match.group(1)) * 1000))
    return None


def word_annotations(interaction: Any) -> list[Any]:
    words: list[Any] = []
    for step in getattr(interaction, "steps", []) or []:
        for content in getattr(step, "content", []) or []:
            for annotation in getattr(content, "annotations", []) or []:
                item = mapping(annotation)
                if item.get("type") == "word_info":
                    words.append(item)
    return words


def wait_for_interaction(client: Any, interaction: Any, description: str, deadline_seconds: int = 2_100) -> Any:
    """Poll a server-side Gemini interaction so long videos outlive HTTP timeouts."""
    interaction_id = getattr(interaction, "id", None) or mapping(interaction).get("id")
    if not interaction_id:
        raise RuntimeError(f"Gemini did not return an interaction ID for {description}.")
    deadline = time.time() + deadline_seconds
    current = interaction
    while time.time() < deadline:
        status = getattr(current, "status", None) or mapping(current).get("status")
        status_name = str(getattr(status, "value", None) or getattr(status, "name", None) or status or "").lower()
        if status_name == "completed":
            return current
        if status_name in {"failed", "cancelled", "canceled", "incomplete"}:
            error = getattr(current, "error", None) or mapping(current).get("error")
            raise RuntimeError(f"Gemini {description} {status_name}: {error or 'no additional error details'}")
        time.sleep(10)
        current = client.interactions.get(id=interaction_id)
    raise RuntimeError(f"Gemini {description} did not finish within {deadline_seconds // 60} minutes.")


def transcript_segments(interaction: Any, duration_ms: int, offset_ms: int = 0) -> list[dict[str, Any]]:
    words = word_annotations(interaction)
    if not words:
        raise RuntimeError("Transcription returned no word-level timestamp annotations; no transcript timestamps were invented.")

    segments: list[dict[str, Any]] = []
    current: list[tuple[int, int, str, str]] = []

    def flush() -> None:
        if not current:
            return
        text = ""
        for _, _, word, _ in current:
            if not text or word[:1] in ",.!?;:%)]}’'":
                text += word
            elif text.endswith(("(", "[", "{“", "‘", "\"")):
                text += word
            else:
                text += " " + word
        segments.append({
            "start_ms": current[0][0] + offset_ms,
            "end_ms": current[-1][1] + offset_ms,
            "speaker_label": current[0][3] or None,
            "text": text.strip(),
            "confidence": None,
            "evidence_source": "gemini_3_5_transcribe_word_timestamps",
        })
        current.clear()

    for raw in words:
        item = mapping(raw)
        text = str(item.get("text") or item.get("word") or "").strip()
        start, end = seconds_to_ms(item.get("start_offset")), seconds_to_ms(item.get("end_offset"))
        if not text or start is None or end is None or end <= start:
            continue
        start, end = min(start, duration_ms), min(end, duration_ms)
        if end <= start:
            continue
        speaker = str(item.get("speaker") or item.get("speaker_label") or item.get("speaker_id") or "").strip()
        if current and (speaker != current[-1][3] or start - current[-1][1] > 1_800 or re.search(r"[.!?][\"'’)]?$", current[-1][2])):
            flush()
        current.append((start, end, text, speaker))
    flush()
    if not segments:
        raise RuntimeError("Transcription contained no usable word-level timestamps; no transcript timestamps were invented.")
    return segments


def download_file(url: str, target: Path, expected_size: int) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "10K-Hub-AI-Clip-Strategist/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response, target.open("wb") as output:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_VIDEO_BYTES:
                raise RuntimeError("Downloaded video exceeded the 2 GB processing limit.")
            output.write(chunk)
    if total != expected_size:
        raise RuntimeError(f"Downloaded file size ({total}) did not match the uploaded size ({expected_size}).")


def video_duration_ms(video: Path) -> int:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        check=True, capture_output=True, text=True, timeout=60,
    )
    duration_ms = round(float(probe.stdout.strip()) * 1000)
    if not 0 < duration_ms <= MAX_ANALYSIS_SECONDS * 1000:
        raise RuntimeError("Video duration must be no longer than two hours.")
    return duration_ms


def extract_audio_chunk(video: Path, audio: Path, offset_ms: int, duration_ms: int) -> None:
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{offset_ms / 1000:.3f}",
        "-i", str(video), "-t", f"{duration_ms / 1000:.3f}", "-vn", "-ac", "1", "-ar", "24000",
        "-b:a", "64k", "-f", "mp3", str(audio),
    ]
    subprocess.run(command, check=True, timeout=900)


def wait_for_file(client: Any, file_resource: Any, deadline_seconds: int = 900) -> Any:
    name = getattr(file_resource, "name", None) or mapping(file_resource).get("name")
    if not name:
        raise RuntimeError("Gemini did not return a file identifier.")
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        current = client.files.get(name=name)
        state = getattr(current, "state", None)
        state_name = getattr(state, "name", None) or mapping(state).get("name")
        if state_name == "ACTIVE":
            return current
        if state_name == "FAILED":
            raise RuntimeError(f"Gemini could not prepare uploaded media {name}.")
        time.sleep(5)
    raise RuntimeError("Gemini media processing timed out after 15 minutes.")


def input_file(file_resource: Any, kind: str) -> dict[str, str]:
    file_data = mapping(file_resource)
    return {
        "type": kind,
        "uri": str(getattr(file_resource, "uri", None) or file_data.get("uri")),
        "mime_type": str(getattr(file_resource, "mime_type", None) or file_data.get("mime_type")),
    }


def analyze_video(client: Any, video_resource: Any, transcript: list[dict[str, Any]], duration_ms: int) -> dict[str, Any]:
    transcript_text = "\n".join(
        f"[{s['start_ms']/1000:.2f}-{s['end_ms']/1000:.2f}s] {s['speaker_label'] or 'Speaker unclear'}: {s['text']}"
        for s in transcript
    )
    prompt = f"""Analyze this complete long-form video for 10K Takes, a Minnesota sports and culture media brand.

Return an editorial shortlist of 5-10 strong short-form clip candidates; return fewer if the footage truly does not support that many. This is a ranking for editors, never a probability of virality. Do not create a finished video, do not publish, and do not invent dialogue, timestamps, trends, performance data, reactions, or events.

The source duration is {duration_ms} milliseconds. Use source-video timestamps rounded to the nearest whole second (start_ms/end_ms and evidence timecodes must be multiples of 1000); do not imply sub-second precision. Candidate start_ms/end_ms must enclose a real moment in the supplied video, be no longer than 180 seconds, and normally be 15-90 seconds. Make each clip understandable and complete. Choose moments based on actual footage: dialogue, visual scene/action, facial reactions, crowd response, humor, conflict, payoff, and audio intensity. Transcript alone is not sufficient. Inspect the video itself.

Timestamped diarized transcript from the same source (speaker labels are generic; do not infer real identities):
{transcript_text}

For each candidate, cite observable evidence with transcript quote timestamps and visual/audio timecodes. Keep factual observations in evidence and put any interpretation about why audiences may respond in hypotheses/rationale. Never call a hypothesis an observed fact. Use a confidence level reflecting timecode, transcript, and visual certainty. Use a 0-100 editorial priority score based on fit for 10K Takes, hook clarity, emotional/comedic payoff, and ease of editing; do not describe it as a probability.

Give a practical Final Cut Pro edit plan: source cut in/out, first-second hook, pacing, caption treatment, on-screen text, ending, and editor notes. Provide a short adaptation for Instagram Reels, Facebook Reels, TikTok, YouTube Shorts, and X. These are editorial adaptations, not verified trend claims. Current platform trend data and 10K Hub historical performance context are not connected: say so in analysis_note and do not invent them.

If fast action is not visibly sampled clearly enough to assess, state that as a limitation. Do not claim to have identified an individual by name. Do not invent audio intensity measurements; qualitative sound descriptions only when clearly audible. Output only the required structured object."""
    response = client.interactions.create(
        model=MODEL_VIDEO,
        input=[{**input_file(video_resource, "video"), "processing": "agentic"}, {"type": "text", "text": prompt}],
        response_format={"type": "text", "mime_type": "application/json", "schema": RESPONSE_SCHEMA},
        generation_config={"max_output_tokens": 20_000, "temperature": 0.2},
        background=True,
    )
    response = wait_for_interaction(client, response, "video analysis")
    output = getattr(response, "output_text", None)
    if not output:
        raise RuntimeError("Video analysis returned no structured output.")
    result = json.loads(output)
    candidates = result.get("candidates")
    if not isinstance(candidates, list) or len(candidates) > 10:
        raise RuntimeError("Video analysis returned an invalid candidate list.")
    for candidate in candidates:
        start, end = candidate.get("start_ms"), candidate.get("end_ms")
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start or end > duration_ms or end - start > 180_000 or start % 1000 or end % 1000:
            raise RuntimeError("Video analysis returned a candidate with invalid source timestamps; results were rejected.")
        if not isinstance(candidate.get("editorial_score"), int) or not 0 <= candidate["editorial_score"] <= 100:
            raise RuntimeError("Video analysis returned an invalid editorial priority score; results were rejected.")
        evidence = candidate.get("evidence", {})
        for quote in evidence.get("transcript_quotes", []):
            quote_start, quote_end = quote.get("start_ms", -1), quote.get("end_ms", duration_ms + 1)
            if quote_start < start or quote_end > end or quote_end <= quote_start or quote_start % 1000 or quote_end % 1000:
                raise RuntimeError("Video analysis cited dialogue outside its proposed clip range; results were rejected.")
            quote_words = re.sub(r"[^\w']+", " ", str(quote.get("quote", "")).lower()).strip()
            nearby = " ".join(
                segment["text"].lower() for segment in transcript
                if segment["end_ms"] >= quote_start - 1_500 and segment["start_ms"] <= quote_end + 1_500
            )
            transcript_words = re.sub(r"[^\w']+", " ", nearby).strip()
            if len(quote_words.split()) < 2 or quote_words not in transcript_words:
                raise RuntimeError("Video analysis quoted words that do not match the transcript near the cited time; results were rejected.")
        for moment in evidence.get("visual_moments", []) + evidence.get("audio_moments", []):
            moment_time = moment.get("time_ms", -1)
            if moment_time < start or moment_time > end or moment_time > duration_ms or moment_time % 1000:
                raise RuntimeError("Video analysis returned an evidence timestamp outside its proposed clip range; results were rejected.")
        edit_plan = candidate.get("edit_plan", {})
        cut_in, cut_out = edit_plan.get("suggested_cut_in_ms"), edit_plan.get("suggested_cut_out_ms")
        if (not isinstance(cut_in, int) or not isinstance(cut_out, int) or cut_in < 0 or cut_out <= cut_in
                or cut_out > duration_ms or cut_in % 1000 or cut_out % 1000):
            raise RuntimeError("Video analysis returned invalid Final Cut Pro source cut points; results were rejected.")
    candidates.sort(key=lambda item: item["editorial_score"], reverse=True)
    return result


def process() -> None:
    base = os.getenv("CONTENT_INTELLIGENCE_API_URL", "").strip().rstrip("/")
    worker_token = os.getenv("CONTENT_INTELLIGENCE_TOKEN", "").strip()
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not base or not worker_token or not gemini_key:
        raise RuntimeError("CONTENT_INTELLIGENCE_API_URL, CONTENT_INTELLIGENCE_TOKEN, and GEMINI_API_KEY are required.")
    if len(worker_token) < 32:
        raise RuntimeError("CONTENT_INTELLIGENCE_TOKEN must be a long secret (at least 32 characters).")

    from google import genai

    job_data = api_request(base + "/v1/clip-jobs/next", worker_token, method="POST", payload={})
    job = job_data.get("job")
    if not job:
        print("No queued AI Clip Strategist video jobs.")
        return
    job_id = job["id"]
    print(f"Processing one video job: {job.get('title', job_id)}")
    client = genai.Client(api_key=gemini_key)
    uploaded: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="10k-clip-") as temporary:
            folder = Path(temporary)
            video_path = folder / (Path(job["filename"]).name or "source-video.mp4")
            download_file(job_data["download_url"], video_path, int(job["file_size_bytes"]))
            duration_ms = video_duration_ms(video_path)
            transcript: list[dict[str, Any]] = []
            for offset_ms in range(0, duration_ms, TRANSCRIPTION_CHUNK_SECONDS * 1000):
                chunk_duration_ms = min(TRANSCRIPTION_CHUNK_SECONDS * 1000, duration_ms - offset_ms)
                audio_path = folder / f"transcript-audio-{offset_ms}.mp3"
                extract_audio_chunk(video_path, audio_path, offset_ms, chunk_duration_ms)
                audio_upload = client.files.upload(file=str(audio_path), config={"mime_type": "audio/mpeg"})
                audio_name = getattr(audio_upload, "name", None) or mapping(audio_upload).get("name")
                if audio_name:
                    uploaded.append(str(audio_name))
                audio_upload = wait_for_file(client, audio_upload)
                transcript_response = client.interactions.create(
                    model=MODEL_TRANSCRIBE,
                    input=[input_file(audio_upload, "audio")],
                    generation_config={"transcription_config": {"mode": {"type": "verbatim", "diarization_mode": "speaker", "timestamp_granularities": ["word"]}}},
                    background=True,
                )
                transcript_response = wait_for_interaction(client, transcript_response, "transcription")
                transcript.extend(transcript_segments(transcript_response, chunk_duration_ms, offset_ms))
                audio_path.unlink(missing_ok=True)
                print(f"Transcribed source range {offset_ms // 1000}s–{(offset_ms + chunk_duration_ms) // 1000}s.")
            print(f"Transcript: {len(transcript)} timestamped speaker segments.")

            video_upload = client.files.upload(file=str(video_path), config={"mime_type": job["mime_type"]})
            video_name = getattr(video_upload, "name", None) or mapping(video_upload).get("name")
            if video_name:
                uploaded.append(str(video_name))
            video_upload = wait_for_file(client, video_upload)
            analysis = analyze_video(client, video_upload, transcript, duration_ms)
            candidates = analysis["candidates"]
            print(f"Video analysis: {len(candidates)} clip candidate(s).")
            provenance = {
                "transcription_model": MODEL_TRANSCRIBE,
                "video_analysis_model": MODEL_VIDEO,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "method": "Gemini dedicated word-timestamped diarization + agentic multimodal video review",
                "limitations": ["Speaker labels are diarization labels, not verified identities, and may restart at each 24-minute transcription chunk.", "Editorial hypotheses and scores are not performance predictions.", "Platform trends and 10K Hub history were not supplied to this run."],
            }
            api_request(base + f"/v1/clip-jobs/{job_id}/results", worker_token, method="POST", payload={
                "duration_ms": duration_ms,
                "transcript_segments": transcript,
                "candidates": candidates,
                "analysis_note": str(analysis.get("analysis_note", "")),
                "model_provenance": provenance,
            })
            print(f"Saved {len(candidates)} evidence-linked candidate(s) to the private Worker.")
    except Exception as error:
        message = f"{type(error).__name__}: {error}"[:500]
        try:
            api_request(base + f"/v1/clip-jobs/{job_id}/fail", worker_token, method="POST", payload={"error": message})
        except Exception as report_error:
            print(f"Could not update job status: {report_error}", file=sys.stderr)
        raise
    finally:
        for name in uploaded:
            try:
                client.files.delete(name=name)
            except Exception as error:
                print(f"Warning: Gemini temporary file cleanup failed for {name}: {error}", file=sys.stderr)


if __name__ == "__main__":
    try:
        process()
    except Exception as exc:
        print(f"AI Clip Strategist failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
