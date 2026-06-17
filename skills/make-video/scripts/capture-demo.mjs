#!/usr/bin/env node
// Stage 3 — CAPTURE: record a live browser demonstration as video footage.
// Drives the user's installed Chrome via playwright-core (no browser download),
// records the session, and vendors an MP4 the composition can embed as a clip.
//
// Usage:
//   node capture-demo.mjs --url <url> [--actions actions.json] [--out demo.mp4]
//                         [--width 1280] [--height 800] [--duration 8]
//
// actions.json — a small declarative DSL (every step is awaited in order):
//   { "steps": [
//       { "wait": 800 },
//       { "scroll": { "by": 900, "duration": 1500 } },     // smooth, controlled speed
//       { "scrollTo": { "selector": "#pricing", "duration": 1200 } },
//       { "click": "text=Get started" },
//       { "type": { "selector": "#search", "text": "video maker", "delay": 60 } },
//       { "press": "Enter" },
//       { "hover": ".plan-card" },
//       { "move": { "x": 640, "y": 400, "steps": 30 } }    // visible cursor travel
//   ] }
//
// Works on any URL — including http://localhost:* for demonstrating a local app.
// The recording is SOURCE FOOTAGE: the determinism contract applies to the final
// composition render, not to how footage was captured. The composition embeds the
// mp4 as a <video> clip with data-start/data-duration.

import { readFileSync, mkdirSync, existsSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

// Resolve playwright-core from the HOST project first (skill may live under
// ~/.claude/skills, where a bare import would not see the project's node_modules).
async function loadChromium() {
  try {
    const req = createRequire(resolve(process.cwd(), "package.json"));
    return (await import(pathToFileURL(req.resolve("playwright-core")).href)).chromium;
  } catch {
    try {
      return (await import("playwright-core")).chromium;
    } catch {
      throw new Error("the capture asset type needs playwright-core — run `npm i -D playwright-core` in this repo (drives your installed Chrome; no browser download)");
    }
  }
}

export async function captureDemo({ url, actions = { steps: [] }, out = "demo.mp4", width = 1280, height = 800, settle = 1000 }) {
  const chromium = await loadChromium();
  const videoDir = resolve(tmpdir(), `vm-capture-${process.pid}`);
  mkdirSync(videoDir, { recursive: true });

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: { dir: videoDir, size: { width, height } },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const recording = page.video(); // grab the handle BEFORE close — its path() resolves after

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(settle);

    for (const step of actions.steps ?? []) {
      if (step.wait != null) await page.waitForTimeout(step.wait);
      else if (step.scroll) {
        const { by = 600, duration = 1200 } = step.scroll;
        const ticks = Math.max(1, Math.round(duration / 50));
        for (let i = 0; i < ticks; i++) {
          await page.mouse.wheel(0, by / ticks);
          await page.waitForTimeout(50);
        }
      } else if (step.scrollTo) {
        const { selector, duration = 1200 } = step.scrollTo;
        await page.locator(selector).first().evaluate((el, ms) => {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          return new Promise(r => setTimeout(r, ms));
        }, duration);
      } else if (step.click) await page.locator(step.click).first().click();
      else if (step.type) {
        const { selector, text, delay = 60 } = step.type;
        await page.locator(selector).first().pressSequentially(text, { delay });
      } else if (step.press) await page.keyboard.press(step.press);
      else if (step.hover) await page.locator(step.hover).first().hover();
      else if (step.move) {
        const { x, y, steps = 25 } = step.move;
        await page.mouse.move(x, y, { steps });
      } else throw new Error(`unknown capture step: ${JSON.stringify(step)}`);
    }
    await page.waitForTimeout(settle);
  } finally {
    await context.close(); // flushes the recording
    await browser.close();
  }

  try {
    const video = await recording?.path();
    if (!video || !existsSync(video)) throw new Error("no recording produced — is Chrome installed? (npx hyperframes doctor)");

    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    // webm (vp8, variable fps) → h264 mp4 @30fps for clean composition embedding
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", video,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", outPath]);

    const dur = +execFileSync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", outPath], { encoding: "utf8" }).trim();
    return { path: outPath, duration: +dur.toFixed(2), width, height };
  } finally {
    rmSync(videoDir, { recursive: true, force: true }); // no temp leak, success or not
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : dflt; };
  const url = get("--url");
  if (!url) {
    console.error("usage: node capture-demo.mjs --url <url> [--actions actions.json] [--out demo.mp4] [--width 1280] [--height 800]");
    process.exit(1);
  }
  const actionsPath = get("--actions");
  let actions = { steps: [] };
  if (actionsPath) {
    if (!existsSync(resolve(actionsPath))) { console.error(`actions file not found: ${actionsPath}`); process.exit(1); }
    actions = JSON.parse(readFileSync(resolve(actionsPath), "utf8"));
  }
  const result = await captureDemo({
    url, actions,
    out: get("--out", "demo.mp4"),
    width: +get("--width", 1280),
    height: +get("--height", 800),
  });
  console.log(`✓ captured ${url} → ${result.path} (${result.duration}s, ${result.width}×${result.height})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
