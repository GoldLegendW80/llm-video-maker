#!/usr/bin/env node
// Normalize any transcript format into the canonical segments JSON the pipeline consumes.
// Usage: node normalize-transcript.mjs <input> [--out transcript.json] [--audio file.wav]
//
// Accepts:
//   .srt                         — SubRip
//   .vtt                         — WebVTT
//   .json                        — whisper verbose JSON ({segments:[{start,end,text}]}),
//                                  hyperframes transcribe output ([{text,start,end}]),
//                                  or already-canonical ({segments:[...]})
// Canonical output:
//   { "source": "...", "duration": 93.4, "segments": [
//       { "id": 1, "start": 0.0, "end": 4.2, "text": "..." }, ... ] }
//
// If --audio is given, ffprobe measures it and the audio duration is recorded so the
// storyboard can verify transcript coverage (gaps and tail silence are legitimate).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function parseTimestamp(ts) {
  // 00:01:02,345 (srt) | 00:01:02.345 (vtt) | 01:02.345 (vtt short)
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) throw new Error(`unparseable timestamp: "${ts}"`);
  const [, h, min, s, ms] = m;
  return (+(h || 0)) * 3600 + (+min) * 60 + (+s) + (+ms.padEnd(3, "0")) / 1000;
}

export function parseSrtVtt(text) {
  const segments = [];
  // split on blank lines; tolerate \r\n
  const blocks = text.replace(/\r/g, "").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) continue;
    const cueIdx = lines.findIndex(l => l.includes("-->"));
    if (cueIdx === -1) continue; // WEBVTT header, NOTE blocks, bare counters
    const [startRaw, endRaw] = lines[cueIdx].split("-->");
    const textLines = lines.slice(cueIdx + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!textLines) continue;
    segments.push({
      start: parseTimestamp(startRaw),
      end: parseTimestamp(endRaw.trim().split(" ")[0]),
      text: textLines,
    });
  }
  return segments;
}

export function parseJson(text) {
  const data = JSON.parse(text);
  let segs;
  if (Array.isArray(data)) segs = data; // hyperframes transcribe / bare array
  else if (Array.isArray(data.segments)) segs = data.segments; // whisper verbose / canonical
  else if (Array.isArray(data.words)) segs = data.words; // word-level fallback
  else throw new Error("unrecognized JSON transcript shape (need array or {segments:[...]})");
  return segs.map(s => {
    const start = s.start ?? (s.startMs != null ? s.startMs / 1000 : undefined) ?? s.timestamp?.[0];
    const end = s.end ?? (s.endMs != null ? s.endMs / 1000 : undefined) ?? s.timestamp?.[1];
    return { start: +start, end: +end, text: String(s.text ?? s.word ?? "").trim() };
  }).filter(s => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));
}

// sanity: sort, clamp negatives, drop zero-length, assign ids
export function sanitizeSegments(segments) {
  return segments
    .map(s => ({ ...s, start: Math.max(0, s.start), end: Math.max(0, s.end) }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ id: i + 1, start: +s.start.toFixed(3), end: +s.end.toFixed(3), text: s.text }));
}

export function overlapWarnings(segments) {
  const warnings = [];
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].start < segments[i - 1].end - 0.25) {
      warnings.push(`overlap: segment ${segments[i - 1].id} ends ${segments[i - 1].end}s after segment ${segments[i].id} starts ${segments[i].start}s`);
    }
  }
  return warnings;
}

// raw text + extension hint → canonical result (+ warnings). Pure of I/O.
export function normalize(raw, ext, { source = null, audioPath = null, audioDuration = null } = {}) {
  const segments = sanitizeSegments(
    ext === ".srt" || ext === ".vtt" ? parseSrtVtt(raw)
    : ext === ".json" ? parseJson(raw)
    : raw.includes("-->") ? parseSrtVtt(raw) : parseJson(raw)
  );
  if (!segments.length) throw new Error("no usable segments found");

  const warnings = overlapWarnings(segments);
  const transcriptEnd = segments[segments.length - 1].end;
  if (audioDuration && Math.abs(audioDuration - transcriptEnd) > 3) {
    warnings.push(`audio is ${audioDuration.toFixed(1)}s but transcript ends at ${transcriptEnd.toFixed(1)}s — verify trailing content`);
  }
  return {
    result: {
      source,
      audio: audioPath || null,
      duration: +(audioDuration ?? transcriptEnd).toFixed(3),
      transcriptEnd: +transcriptEnd.toFixed(3),
      segments,
    },
    warnings,
  };
}

export function probeAudioDuration(audioPath) {
  return +execFileSync(
    "ffprobe",
    ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", resolve(audioPath)],
    { encoding: "utf8" }
  ).trim();
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  const outIdx = args.indexOf("--out");
  const outPath = outIdx > -1 ? args[outIdx + 1] : "transcript.json";
  const audioIdx = args.indexOf("--audio");
  const audioPath = audioIdx > -1 ? args[audioIdx + 1] : null;

  if (!input) {
    console.error("usage: node normalize-transcript.mjs <input.(srt|vtt|json)> [--out transcript.json] [--audio narration.wav]");
    process.exit(1);
  }
  if (!existsSync(resolve(input))) {
    console.error(`transcript file not found: ${input}`);
    process.exit(1);
  }
  const raw = readFileSync(resolve(input), "utf8");

  let audioDuration = null;
  if (audioPath) {
    try { audioDuration = probeAudioDuration(audioPath); }
    catch { console.warn("⚠ ffprobe failed on --audio; duration not recorded"); }
  }

  let normalized;
  try {
    normalized = normalize(raw, extname(input).toLowerCase(), { source: input, audioPath, audioDuration });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const w of normalized.warnings) console.warn(`⚠ ${w}`);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(normalized.result, null, 2));
  console.log(`${normalized.result.segments.length} segments · ${normalized.result.duration}s → ${outPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
