#!/usr/bin/env node
// Stage 2 (transcript-locked) — deterministic segment→scene mapper + coverage assertion.
//
// The sync contract between a user's narration and the storyboard must NOT depend on an
// LLM following prose rules at 100 segments. This script owns the mechanical mapping;
// the LLM keeps naming, beats, techniques, and visuals only.
//
// Plan mode:   node plan-scenes.mjs <transcript.json> [--out scene-plan.json]
//   → scene skeleton: windows + segmentIds + subBeats hints + gapAfter.
// Check mode:  node plan-scenes.mjs <transcript.json> --check <storyboard.json>
//   → asserts the storyboard's scenes cover every segment exactly once and that scene
//     boundaries sit inside segment gaps (±0.3s). Exit 1 with violations otherwise.
//
// Mapping rules (mirror .claude/skills/make-video/SKILL.md stage 2):
//   - merge consecutive segments until the scene span ≥ MIN_SCENE (2.5s), but never
//     merge across a breathing gap (≥ GAP_BREATH = 1.5s)
//   - a trailing short segment that cannot reach MIN_SCENE joins the previous scene
//     when the gap allows it
//   - a scene longer than MAX_SCENE (9s) gets a subBeats hint (sub-beats share the
//     scene window; the scene is NOT split — the window is the sync contract)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_SCENE = 2.5;
export const MAX_SCENE = 9;
export const GAP_BREATH = 1.5;
export const BOUNDARY_TOL = 0.3;
const SUB_BEAT_TARGET = 5; // seconds per sub-beat inside an over-long scene

export function planScenes(segments, { minScene = MIN_SCENE, maxScene = MAX_SCENE, gapBreath = GAP_BREATH } = {}) {
  if (!segments?.length) throw new Error("no segments to plan");
  const groups = [];
  let current = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!current) { current = [seg]; continue; }
    const last = current[current.length - 1];
    const gap = seg.start - last.end;
    const span = last.end - current[0].start;
    if (span < minScene && gap < gapBreath) current.push(seg);
    else { groups.push(current); current = [seg]; }
  }
  if (current) {
    // trailing group too short to stand alone → fold into previous scene if the gap allows
    const span = current[current.length - 1].end - current[0].start;
    const prev = groups[groups.length - 1];
    if (span < minScene && prev && current[0].start - prev[prev.length - 1].end < gapBreath) {
      prev.push(...current);
    } else {
      groups.push(current);
    }
  }

  const scenes = groups.map((g, i) => {
    const start = +g[0].start.toFixed(3);
    const end = +g[g.length - 1].end.toFixed(3);
    const duration = +(end - start).toFixed(3);
    const scene = {
      id: `s${String(i + 1).padStart(2, "0")}`,
      start, end, duration,
      segmentIds: g.map(s => s.id),
    };
    if (duration > maxScene) scene.subBeats = Math.ceil(duration / SUB_BEAT_TARGET);
    return scene;
  });
  for (let i = 0; i < scenes.length; i++) {
    const next = scenes[i + 1];
    scenes[i].gapAfter = next ? +(next.start - scenes[i].end).toFixed(3) : null;
  }
  return scenes;
}

// storyboard scenes vs transcript segments → list of violations (empty = covered).
export function checkCoverage(segments, scenes, { tol = BOUNDARY_TOL } = {}) {
  const violations = [];
  const segById = new Map(segments.map(s => [s.id, s]));
  const seen = new Map(); // segment id → scene id

  const timed = scenes
    .filter(s => Array.isArray(s.segmentIds))
    .map(s => ({ ...s, end: s.end ?? +(s.start + s.duration).toFixed(3) }))
    .sort((a, b) => a.start - b.start);

  if (!timed.length) return ["no scenes carry segmentIds — transcript-locked storyboards must map every scene to segments"];

  for (const scene of timed) {
    for (const id of scene.segmentIds) {
      if (!segById.has(id)) violations.push(`scene ${scene.id}: segmentId ${id} does not exist in the transcript`);
      else if (seen.has(id)) violations.push(`segment ${id} mapped twice: scenes ${seen.get(id)} and ${scene.id}`);
      else seen.set(id, scene.id);
    }
    const segs = scene.segmentIds.map(id => segById.get(id)).filter(Boolean);
    if (!segs.length) continue;
    const first = segs[0], last = segs[segs.length - 1];
    if (scene.start > first.start + tol)
      violations.push(`scene ${scene.id} starts at ${scene.start}s but its first segment starts at ${first.start}s (scene must cover it)`);
    if (scene.end < last.end - tol)
      violations.push(`scene ${scene.id} ends at ${scene.end}s but its last segment ends at ${last.end}s (scene must cover it)`);
  }

  for (const seg of segments) {
    if (!seen.has(seg.id)) violations.push(`segment ${seg.id} (${seg.start}–${seg.end}s "${seg.text.slice(0, 40)}…") is not mapped to any scene`);
  }

  // boundaries must sit inside segment gaps: a scene may not start/end mid-segment it doesn't own
  for (const scene of timed) {
    for (const seg of segments) {
      if (scene.segmentIds.includes(seg.id)) continue;
      const startsInside = scene.start > seg.start + tol && scene.start < seg.end - tol;
      const endsInside = scene.end > seg.start + tol && scene.end < seg.end - tol;
      if (startsInside) violations.push(`scene ${scene.id} starts at ${scene.start}s — mid-sentence inside segment ${seg.id} (${seg.start}–${seg.end}s)`);
      if (endsInside) violations.push(`scene ${scene.id} ends at ${scene.end}s — mid-sentence inside segment ${seg.id} (${seg.start}–${seg.end}s)`);
    }
  }

  // scenes must not overlap each other
  for (let i = 1; i < timed.length; i++) {
    if (timed[i].start < timed[i - 1].end - 0.001)
      violations.push(`scenes ${timed[i - 1].id} and ${timed[i].id} overlap (${timed[i - 1].end}s > ${timed[i].start}s)`);
  }
  return violations;
}

function loadTranscript(path) {
  if (!existsSync(resolve(path))) {
    console.error(`transcript not found: ${path} — run pipeline/normalize-transcript.mjs first`);
    process.exit(1);
  }
  const t = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!Array.isArray(t.segments)) {
    console.error(`${path} is not a canonical transcript (missing segments[]) — run pipeline/normalize-transcript.mjs`);
    process.exit(1);
  }
  return t;
}

function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input) {
    console.error("usage: node plan-scenes.mjs <transcript.json> [--out scene-plan.json] [--check storyboard.json]");
    process.exit(1);
  }
  const transcript = loadTranscript(input);
  const checkIdx = args.indexOf("--check");

  if (checkIdx > -1) {
    const sbPath = args[checkIdx + 1];
    if (!sbPath || !existsSync(resolve(sbPath))) {
      console.error(`storyboard not found: ${sbPath}`);
      process.exit(1);
    }
    const sb = JSON.parse(readFileSync(resolve(sbPath), "utf8"));
    const violations = checkCoverage(transcript.segments, sb.scenes || []);
    if (violations.length) {
      console.error(`✗ coverage check FAILED (${violations.length}):`);
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log(`✓ coverage OK: ${transcript.segments.length} segments across ${(sb.scenes || []).length} scenes, all boundaries in gaps`);
    return;
  }

  const outIdx = args.indexOf("--out");
  const outPath = outIdx > -1 ? args[outIdx + 1] : "scene-plan.json";
  const scenes = planScenes(transcript.segments);
  const plan = {
    generatedFrom: input,
    params: { minScene: MIN_SCENE, maxScene: MAX_SCENE, gapBreath: GAP_BREATH },
    audioDuration: transcript.duration,
    scenes,
  };
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(`${scenes.length} scenes planned from ${transcript.segments.length} segments → ${outPath}`);
  for (const s of scenes) {
    const beats = s.subBeats ? ` (${s.subBeats} sub-beats)` : "";
    console.log(`  ${s.id}: ${s.start}–${s.end}s · segs [${s.segmentIds.join(",")}]${beats}${s.gapAfter >= GAP_BREATH ? ` · ${s.gapAfter}s breathing room after` : ""}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
