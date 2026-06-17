#!/usr/bin/env node
// Stage -1 — brief validation with actionable error messages.
// Usage: node validate-brief.mjs <brief.json>
//
// Mirrors the skill's schema.json but explains failures in terms a user can act on
// ("width 1079 is odd — H.264 yuv420 needs even dimensions; use 1080"), and adds
// semantic checks a JSON Schema can't express (referenced files must exist,
// chapter ids unique, user-audio needs an audio file). Exit 1 on errors;
// warnings alone exit 0.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_PRESETS = ["tiktok", "reels", "shorts", "youtube", "square"];
const FPS_VALUES = [24, 25, 30, 50, 60];
const NARRATION_MODES = ["none", "tts", "user-audio"];
const NARRATION_ENGINES = ["kokoro", "openai"];
const STYLE_PRESETS = [
  "bold-energetic", "warm-editorial", "dark-premium", "clean-corporate",
  "nature-earth", "neon-electric", "pastel-soft", "jewel-rich", "monochrome",
];
const IMAGE_GEN_MODES = ["placeholder", "openai", "fal", "none"];
const OUTPUT_FORMATS = ["mp4", "webm", "mov", "gif"];
const OUTPUT_QUALITIES = ["draft", "standard", "high"];
const TRANSCRIPT_EXTS = [".srt", ".vtt", ".json"];

// briefDir lets relative asset paths (audio_file, transcript_file, music.file,
// design_md) resolve against the brief's own directory, then the CWD.
export function validateBrief(brief, { briefDir = process.cwd() } = {}) {
  const errors = [];
  const warnings = [];
  const err = m => errors.push(m);
  const warn = m => warnings.push(m);

  const fileRef = (path, label) => {
    if (typeof path !== "string" || !path) return err(`${label} must be a non-empty path string`);
    const tried = [resolve(briefDir, path), resolve(process.cwd(), path)];
    if (!tried.some(p => existsSync(p))) {
      err(`${label} not found: "${path}" (looked in ${tried.join(" and ")})`);
    }
  };

  if (typeof brief !== "object" || brief === null || Array.isArray(brief)) {
    return { errors: ["brief must be a JSON object"], warnings };
  }

  // id
  if (!brief.id) err(`missing "id" — a lowercase slug like "my-launch-video"; output lands in projects/<id>/`);
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(brief.id)) err(`id "${brief.id}" must be a lowercase slug (a-z, 0-9, hyphens; starts alphanumeric)`);

  // platform
  if (brief.platform == null) {
    err(`missing "platform" — a preset (${PLATFORM_PRESETS.join("|")}) or {width, height, fps}`);
  } else if (typeof brief.platform === "string") {
    if (!PLATFORM_PRESETS.includes(brief.platform))
      err(`unknown platform preset "${brief.platform}" — use ${PLATFORM_PRESETS.join("|")} or a custom {width, height, fps} object`);
  } else if (typeof brief.platform === "object") {
    const { width, height, fps } = brief.platform;
    for (const [k, v] of [["width", width], ["height", height]]) {
      if (!Number.isInteger(v)) err(`platform.${k} must be an integer (got ${JSON.stringify(v)})`);
      else if (v < 240) err(`platform.${k} ${v} is below the 240px minimum`);
      else if (v % 2 !== 0) err(`platform.${k} ${v} is odd — H.264 yuv420 needs even dimensions; use ${v + 1} or ${v - 1}`);
    }
    if (fps != null && !FPS_VALUES.includes(fps)) err(`platform.fps ${fps} unsupported — use one of ${FPS_VALUES.join(", ")}`);
  } else err(`platform must be a preset string or {width, height, fps} object`);

  // story
  if (!brief.story) err(`missing "story" — free text describing what the video should say/show`);
  else if (typeof brief.story !== "string" || brief.story.trim().length < 10)
    err(`"story" is too short (${String(brief.story).length} chars) — describe the narrative intent in at least a sentence`);

  // source
  const src = brief.source;
  if (!src || typeof src !== "object") {
    err(`missing "source" — {type: "codebase", path} | {type: "topic", query} | {type: "script", text?}`);
  } else if (src.type === "codebase") {
    if (!src.path) err(`source.type "codebase" requires "path" (the repository to present)`);
    else if (!existsSync(resolve(briefDir, src.path)) && !existsSync(resolve(src.path)))
      err(`source.path not found: "${src.path}" — must point at the repository to analyze`);
  } else if (src.type === "topic") {
    if (!src.query) err(`source.type "topic" requires "query" (what to research before storyboarding)`);
  } else if (src.type === "script") {
    if (!src.text && !brief.story) err(`source.type "script" needs "text", or a "story" that serves as the script`);
  } else {
    err(`unknown source.type "${src?.type}" — use codebase | topic | script`);
  }

  // narration
  const mode = brief.narration?.mode ?? (brief.narration?.enabled ? "tts" : "none");
  if (brief.narration?.enabled != null)
    warn(`narration.enabled is deprecated — use narration.mode: "${brief.narration.enabled ? "tts" : "none"}"`);
  if (brief.narration?.mode != null && !NARRATION_MODES.includes(brief.narration.mode))
    err(`narration.mode "${brief.narration.mode}" unknown — use ${NARRATION_MODES.join(" | ")}`);
  if (brief.narration?.engine != null && !NARRATION_ENGINES.includes(brief.narration.engine))
    err(`narration.engine "${brief.narration.engine}" unknown — use ${NARRATION_ENGINES.join(" | ")}`);
  if (mode === "user-audio") {
    if (!brief.narration.audio_file) err(`narration.mode "user-audio" requires audio_file (your narration recording)`);
    else fileRef(brief.narration.audio_file, "narration.audio_file");
    if (brief.narration.transcript_file) {
      fileRef(brief.narration.transcript_file, "narration.transcript_file");
      const ext = extname(brief.narration.transcript_file).toLowerCase();
      if (!TRANSCRIPT_EXTS.includes(ext))
        err(`narration.transcript_file has extension "${ext}" — supported: ${TRANSCRIPT_EXTS.join(", ")}`);
    } else if (brief.narration.audio_file) {
      warn(`no transcript_file — the pipeline will transcribe the audio locally (hyperframes transcribe) before storyboarding`);
    }
  }

  // duration_s — required unless the transcript owns the clock
  if (brief.duration_s == null) {
    if (mode !== "user-audio")
      err(`missing "duration_s" — required unless narration.mode is "user-audio" (where the audio owns the clock)`);
  } else {
    if (typeof brief.duration_s !== "number" || brief.duration_s < 5 || brief.duration_s > 600)
      err(`duration_s ${brief.duration_s} out of range — must be 5–600 seconds`);
    if (mode === "user-audio")
      warn(`duration_s is ignored in user-audio mode (the recording owns the clock); it is only checked for >5% divergence`);
  }

  // chapters
  if (brief.chapters != null) {
    if (!Array.isArray(brief.chapters)) err(`chapters must be an array`);
    else {
      const ids = new Set();
      brief.chapters.forEach((c, i) => {
        if (!c.id || !c.title) err(`chapters[${i}] needs both "id" and "title"`);
        if (c.id && ids.has(c.id)) err(`duplicate chapter id "${c.id}" — chapter ids must be unique (they address re-renders)`);
        ids.add(c.id);
        if (c.from_s != null && c.to_s != null && c.from_s >= c.to_s)
          err(`chapter "${c.id}": from_s ${c.from_s} must be before to_s ${c.to_s}`);
      });
    }
  }

  // music / captions / style / assets / output
  if (brief.music?.enabled) {
    if (!brief.music.file) err(`music.enabled needs music.file — path to a licensed local audio track you provide (a CC0 pack works well)`);
    else fileRef(brief.music.file, "music.file");
    if (mode === "user-audio") warn(`music + user-audio: music ducking under narration is not tuned yet — expect a manual mix pass`);
  }
  if (brief.captions?.enabled && mode === "none")
    warn(`captions.enabled with narration.mode "none" — captions need narration words; nothing will be captioned`);
  if (brief.style?.preset != null && !STYLE_PRESETS.includes(brief.style.preset))
    err(`style.preset "${brief.style.preset}" unknown — use ${STYLE_PRESETS.join(" | ")} (or point style.design_md at a brand kit)`);
  if (brief.style?.design_md) fileRef(brief.style.design_md, "style.design_md");
  if (brief.assets?.image_gen != null && !IMAGE_GEN_MODES.includes(brief.assets.image_gen))
    err(`assets.image_gen "${brief.assets.image_gen}" unknown — use ${IMAGE_GEN_MODES.join(" | ")}`);
  if (brief.output?.format != null && !OUTPUT_FORMATS.includes(brief.output.format))
    err(`output.format "${brief.output.format}" unknown — use ${OUTPUT_FORMATS.join(" | ")}`);
  if (brief.output?.quality != null && !OUTPUT_QUALITIES.includes(brief.output.quality))
    err(`output.quality "${brief.output.quality}" unknown — use ${OUTPUT_QUALITIES.join(" | ")}`);

  return { errors, warnings };
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node validate-brief.mjs <brief.json>");
    process.exit(1);
  }
  if (!existsSync(resolve(path))) {
    console.error(`brief not found: ${path}`);
    process.exit(1);
  }
  let brief;
  try {
    brief = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (e) {
    console.error(`brief is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const { errors, warnings } = validateBrief(brief, { briefDir: dirname(resolve(path)) });
  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (errors.length) {
    console.error(`✗ brief invalid (${errors.length} error${errors.length > 1 ? "s" : ""}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`✓ brief valid${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})` : ""}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
