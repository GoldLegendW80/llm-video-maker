#!/usr/bin/env node
// Stage 3 — ASSETS: resolves a storyboard asset manifest into local files.
// Usage: node fetch-assets.mjs <manifest.json> --dest <assets-dir> [--strict]
//
// Manifest entries (array):
//   { "type": "icon",  "set": "lucide", "name": "rocket", "out": "icons/rocket.svg", "color": "#5eead4" }
//   { "type": "brand", "slug": "github", "out": "icons/github.svg", "color": "ffffff" }
//   { "type": "image", "provider": "pixabay", "query": "city night aerial", "out": "img/city.jpg", "orientation": "vertical" }
//   { "type": "imagegen", "prompt": "isometric illustration of …", "out": "gen/hero.png", "size": "1024x1536" }
//   { "type": "gif",   "query": "mind blown", "out": "gifs/mind-blown.mp4" }          // Giphy/Tenor (key) — saved as mp4
//   { "type": "meme",  "template": "Drake Hotline Bling", "out": "memes/drake.jpg" }  // imgflip templates, keyless
//   { "type": "video", "query": "typing on laptop", "out": "vid/typing.mp4", "orientation": "landscape", "max_s": 15 }
//   { "type": "sfx",   "query": "whoosh transition", "out": "sfx/whoosh.mp3", "max_s": 4 }   // Freesound CC0
//   { "type": "web",   "url": "https://…/file.png", "out": "img/chart.png",
//     "license": "CC-BY 4.0", "source": "https://…/page" }                            // license fields REQUIRED
//   { "type": "capture", "url": "https://myapp.dev", "out": "demo/tour.mp4",
//     "actions": [{ "scroll": { "by": 900, "duration": 1500 } }], "width": 1280, "height": 800 }
//
// Sources: Iconify (keyless), simple-icons CDN (keyless), imgflip templates (keyless),
// Pixabay images+videos (PIXABAY_API_KEY), Pexels images+videos (PEXELS_API_KEY),
// Giphy (GIPHY_API_KEY) / Tenor (TENOR_API_KEY), Freesound CC0 (FREESOUND_API_KEY),
// OpenAI image gen (OPENAI_API_KEY, opt-in via IMAGE_GEN=openai),
// live browser capture via pipeline/capture-demo.mjs (system Chrome).
// imagegen default: write a .prompt.json sidecar — the composition renders a styled placeholder slot.
// Everything is vendored locally with license sidecars; compositions must never hotlink
// (determinism contract — the only network is at BUILD time, right here).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 25_000_000;

// `out` comes from an LLM-authored manifest — clamp it inside dest (path traversal guard).
export function safePath(dest, out) {
  if (isAbsolute(out)) throw new Error(`absolute out path rejected: ${out}`);
  const p = resolve(dest, out);
  if (p !== dest && !p.startsWith(dest + sep)) throw new Error(`out path escapes assets dir: ${out}`);
  return p;
}

function save(ctx, out, data) {
  const p = safePath(ctx.dest, out);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

async function fetchOk(ctx, url, init = {}) {
  const timeout = init.timeoutMs ?? FETCH_TIMEOUT_MS;
  const r = await ctx.fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  const len = +(r.headers.get("content-length") || 0);
  if (len > MAX_RESPONSE_BYTES) throw new Error(`response too large (${len} bytes) — ${url}`);
  return r;
}

// binary download with the size cap enforced on the ACTUAL bytes (content-length may
// be absent) and a generous timeout — stock videos/gifs routinely outlive 20s.
async function fetchBuf(ctx, url, init = {}) {
  const r = await fetchOk(ctx, url, { timeoutMs: 120_000, ...init });
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error(`response too large (${buf.byteLength} bytes) — ${url}`);
  return Buffer.from(buf);
}

async function icon(e, ctx) {
  // Iconify: 275k+ icons, keyless. color is applied via ?color= for monotone sets.
  const color = e.color ? `?color=${encodeURIComponent(e.color)}` : "";
  const url = `https://api.iconify.design/${encodeURIComponent(e.set)}/${encodeURIComponent(e.name)}.svg${color}`;
  const svg = await (await fetchOk(ctx, url)).text();
  if (!svg.includes("<svg")) throw new Error(`not an svg: ${url}`);
  return save(ctx, e.out, svg);
}

async function brand(e, ctx) {
  // simple-icons: brand logos, CC0 (trademarks still apply). color = hex without '#'.
  const url = `https://cdn.simpleicons.org/${encodeURIComponent(e.slug)}${e.color ? "/" + encodeURIComponent(e.color.replace("#", "")) : ""}`;
  const svg = await (await fetchOk(ctx, url)).text();
  return save(ctx, e.out, svg);
}

async function image(e, ctx) {
  const provider = e.provider || (ctx.env.PIXABAY_API_KEY ? "pixabay" : "pexels");
  if (provider === "pixabay") {
    const key = ctx.env.PIXABAY_API_KEY;
    if (!key) throw new Error("PIXABAY_API_KEY not set");
    const u = new URL("https://pixabay.com/api/");
    u.searchParams.set("key", key);
    u.searchParams.set("q", e.query);
    u.searchParams.set("image_type", "photo");
    u.searchParams.set("orientation", e.orientation || "all");
    u.searchParams.set("safesearch", "true");
    u.searchParams.set("per_page", "5");
    const j = await (await fetchOk(ctx, u)).json();
    const hit = j.hits?.[0];
    if (!hit) throw new Error(`no pixabay results for "${e.query}"`);
    const img = await fetchBuf(ctx, hit.largeImageURL);
    save(ctx, e.out + ".credit.json", JSON.stringify({
      source: hit.pageURL, provider: "Pixabay",
      license: "Pixabay Content License (free use, no attribution required)",
    }, null, 2));
    return save(ctx, e.out, img);
  }
  if (provider === "pexels") {
    const key = ctx.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY not set");
    const u = new URL("https://api.pexels.com/v1/search");
    u.searchParams.set("query", e.query);
    u.searchParams.set("orientation", e.orientation === "vertical" ? "portrait" : e.orientation || "landscape");
    u.searchParams.set("per_page", "5");
    const j = await (await fetchOk(ctx, u, { headers: { Authorization: key } })).json();
    const hit = j.photos?.[0];
    if (!hit) throw new Error(`no pexels results for "${e.query}"`);
    const img = await fetchBuf(ctx, hit.src.large2x);
    save(ctx, e.out + ".credit.json", JSON.stringify({ photographer: hit.photographer, url: hit.url, source: "Pexels" }, null, 2));
    return save(ctx, e.out, img);
  }
  throw new Error(`unknown image provider: ${provider}`);
}

async function imagegen(e, ctx) {
  if (ctx.imageGen === "openai" && ctx.env.OPENAI_API_KEY) {
    const r = await fetchOk(ctx, "https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: ctx.env.IMAGE_GEN_MODEL || "gpt-image-1-mini",
        prompt: e.prompt,
        size: e.size || "1024x1024",
        n: 1,
      }),
    });
    const j = await r.json();
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw new Error("no image in response");
    return save(ctx, e.out, Buffer.from(b64, "base64"));
  }
  // placeholder mode: sidecar carries the prompt; the composition renders a styled slot.
  return save(ctx, e.out + ".prompt.json", JSON.stringify({ prompt: e.prompt, size: e.size || "1024x1024", status: "placeholder" }, null, 2));
}

async function gif(e, ctx) {
  // Saved as MP4 when the provider offers it (smaller, loops cleanly as a <video> clip).
  if (ctx.env.GIPHY_API_KEY) {
    const u = new URL("https://api.giphy.com/v1/gifs/search");
    u.searchParams.set("api_key", ctx.env.GIPHY_API_KEY);
    u.searchParams.set("q", e.query);
    u.searchParams.set("limit", "5");
    u.searchParams.set("rating", e.rating || "pg");
    const j = await (await fetchOk(ctx, u)).json();
    const hit = j.data?.[0];
    if (!hit) throw new Error(`no giphy results for "${e.query}"`);
    const mp4 = hit.images?.original_mp4?.mp4;
    const media = mp4 || hit.images?.original?.url;
    const out = mp4 ? e.out : e.out.replace(/\.mp4$/, ".gif"); // container must match extension
    const buf = await fetchBuf(ctx, media);
    save(ctx, e.out + ".credit.json", JSON.stringify({
      title: hit.title, source: hit.url, provider: "Giphy",
      license: "Giphy library content — see Giphy ToS; attribution badge recommended",
    }, null, 2));
    return save(ctx, out, buf);
  }
  if (ctx.env.TENOR_API_KEY) {
    const u = new URL("https://tenor.googleapis.com/v2/search");
    u.searchParams.set("key", ctx.env.TENOR_API_KEY);
    u.searchParams.set("q", e.query);
    u.searchParams.set("limit", "5");
    u.searchParams.set("media_filter", "mp4,gif");
    const j = await (await fetchOk(ctx, u)).json();
    const hit = j.results?.[0];
    if (!hit) throw new Error(`no tenor results for "${e.query}"`);
    const mp4t = hit.media_formats?.mp4?.url;
    const media = mp4t || hit.media_formats?.gif?.url;
    const out = mp4t ? e.out : e.out.replace(/\.mp4$/, ".gif");
    const buf = await fetchBuf(ctx, media);
    save(ctx, e.out + ".credit.json", JSON.stringify({
      title: hit.content_description, source: hit.itemurl, provider: "Tenor",
      license: "Tenor library content — see Tenor ToS",
    }, null, 2));
    return save(ctx, out, buf);
  }
  throw new Error("GIPHY_API_KEY or TENOR_API_KEY not set (both have free tiers)");
}

async function meme(e, ctx) {
  // imgflip's template catalog is keyless. We vendor the TEMPLATE — the composition
  // overlays the caption text itself (sharper, on-palette, and animatable).
  const j = await (await fetchOk(ctx, "https://api.imgflip.com/get_memes")).json();
  if (!j.success) throw new Error("imgflip get_memes failed");
  const want = e.template.toLowerCase();
  const hit = j.data.memes.find(m => m.name.toLowerCase() === want)
    || j.data.memes.find(m => m.name.toLowerCase().includes(want));
  if (!hit) throw new Error(`no imgflip template matching "${e.template}" — browse https://imgflip.com/memetemplates`);
  const buf = await fetchBuf(ctx, hit.url);
  save(ctx, e.out + ".credit.json", JSON.stringify({
    template: hit.name, source: `https://imgflip.com/meme/${hit.id}`, provider: "imgflip",
    license: "Meme template — rights vary by underlying image; user assumes editorial-use responsibility",
    boxCount: hit.box_count,
  }, null, 2));
  return save(ctx, e.out, Buffer.from(buf));
}

async function video(e, ctx) {
  const provider = e.provider || (ctx.env.PEXELS_API_KEY ? "pexels" : "pixabay");
  if (provider === "pexels") {
    const key = ctx.env.PEXELS_API_KEY;
    if (!key) throw new Error("PEXELS_API_KEY not set");
    const u = new URL("https://api.pexels.com/videos/search");
    u.searchParams.set("query", e.query);
    u.searchParams.set("orientation", e.orientation === "vertical" ? "portrait" : e.orientation || "landscape");
    u.searchParams.set("per_page", "10");
    const j = await (await fetchOk(ctx, u, { headers: { Authorization: key } })).json();
    const hit = (j.videos || []).find(v => !e.max_s || v.duration <= e.max_s) || j.videos?.[0];
    if (!hit) throw new Error(`no pexels videos for "${e.query}"`);
    const files = (hit.video_files || []).filter(f => f.file_type === "video/mp4")
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const file = files.find(f => (f.width || 0) <= 1920) || files[files.length - 1];
    if (!file) throw new Error(`pexels video ${hit.id} has no mp4 rendition`);
    const buf = await fetchBuf(ctx, file.link);
    save(ctx, e.out + ".credit.json", JSON.stringify({
      videographer: hit.user?.name, source: hit.url, provider: "Pexels",
      license: "Pexels License (free use, no attribution required)", duration_s: hit.duration,
    }, null, 2));
    return save(ctx, e.out, buf);
  }
  if (provider === "pixabay") {
    const key = ctx.env.PIXABAY_API_KEY;
    if (!key) throw new Error("PIXABAY_API_KEY not set");
    const u = new URL("https://pixabay.com/api/videos/");
    u.searchParams.set("key", key);
    u.searchParams.set("q", e.query);
    u.searchParams.set("safesearch", "true");
    u.searchParams.set("per_page", "10");
    const j = await (await fetchOk(ctx, u)).json();
    const hit = (j.hits || []).find(v => !e.max_s || v.duration <= e.max_s) || j.hits?.[0];
    if (!hit) throw new Error(`no pixabay videos for "${e.query}"`);
    const file = hit.videos?.large?.url || hit.videos?.medium?.url || hit.videos?.small?.url;
    const buf = await fetchBuf(ctx, file);
    save(ctx, e.out + ".credit.json", JSON.stringify({
      source: hit.pageURL, provider: "Pixabay",
      license: "Pixabay Content License (free use, no attribution required)", duration_s: hit.duration,
    }, null, 2));
    return save(ctx, e.out, buf);
  }
  throw new Error(`unknown video provider: ${provider}`);
}

async function sfx(e, ctx) {
  const key = ctx.env.FREESOUND_API_KEY;
  if (!key) throw new Error("FREESOUND_API_KEY not set (free at freesound.org/apiv2/apply)");
  const u = new URL("https://freesound.org/apiv2/search/text/");
  u.searchParams.set("query", e.query);
  u.searchParams.set("filter", `license:"Creative Commons 0"${e.max_s ? ` duration:[0 TO ${e.max_s}]` : ""}`);
  u.searchParams.set("fields", "id,name,username,license,previews,url,duration");
  u.searchParams.set("sort", "score");
  u.searchParams.set("token", key);
  const j = await (await fetchOk(ctx, u)).json();
  const hit = j.results?.[0];
  if (!hit) throw new Error(`no CC0 freesound results for "${e.query}"`);
  const buf = await fetchBuf(ctx, hit.previews["preview-hq-mp3"]);
  save(ctx, e.out + ".credit.json", JSON.stringify({
    name: hit.name, author: hit.username, source: hit.url, provider: "Freesound",
    license: "CC0 1.0", duration_s: hit.duration,
  }, null, 2));
  return save(ctx, e.out, buf);
}

async function web(e, ctx) {
  // Arbitrary web download — the escape hatch for anything found by media research.
  // License provenance is NOT optional: refuse entries that don't carry it.
  if (!e.url) throw new Error("web asset needs url");
  if (!e.license || !e.source) {
    throw new Error(`web asset "${e.out}" missing license/source — record where it came from and under what terms, or use a provider type`);
  }
  const buf = await fetchBuf(ctx, e.url);
  save(ctx, e.out + ".credit.json", JSON.stringify({
    source: e.source, directUrl: e.url, license: e.license, note: e.note || null,
  }, null, 2));
  return save(ctx, e.out, buf);
}

async function capture(e, ctx) {
  // Live browser demonstration (any URL, incl. http://localhost — local app demos).
  const { captureDemo } = await import("./capture-demo.mjs");
  const outPath = safePath(ctx.dest, e.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const result = await captureDemo({
    url: e.url,
    actions: { steps: e.actions || [] },
    out: outPath,
    width: e.width || 1280,
    height: e.height || 800,
  });
  save(ctx, e.out + ".credit.json", JSON.stringify({
    source: e.url, provider: "live capture (playwright + system Chrome)",
    license: "own recording — subject to the captured site's content rights",
    duration_s: result.duration,
  }, null, 2));
  return outPath;
}

const handlers = { icon, brand, image, imagegen, gif, meme, video, sfx, web, capture };

// Resolve every manifest entry; never throws — failures land in results as status:"error".
export async function resolveManifest(manifest, ctx) {
  ctx = { fetchImpl: globalThis.fetch, env: process.env, imageGen: "placeholder", ...ctx };
  mkdirSync(ctx.dest, { recursive: true });
  const results = [];
  for (const e of manifest) {
    const h = handlers[e.type];
    try {
      if (!h) throw new Error(`unknown asset type: ${e.type}`);
      const p = await h(e, ctx);
      results.push({ ...e, status: "ok", path: p });
      ctx.quiet || console.log(`✓ ${e.type} ${e.out}`);
    } catch (err) {
      results.push({ ...e, status: "error", error: String(err.message || err) });
      ctx.quiet || console.error(`✗ ${e.type} ${e.out}: ${err.message}`);
    }
  }
  writeFileSync(join(ctx.dest, "manifest.resolved.json"), JSON.stringify(results, null, 2));
  return results;
}

// --strict: any failure is fatal (CI / transcript-locked contexts). Default: all-fail only.
export function exitCode(results, strict) {
  const failed = results.filter(r => r.status === "error").length;
  return failed && (strict || failed === results.length) ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = args[0];
  const destIdx = args.indexOf("--dest");
  const dest = resolve(destIdx > -1 ? args[destIdx + 1] : "assets");
  const strict = args.includes("--strict");
  if (!manifestPath) {
    console.error("usage: node fetch-assets.mjs <manifest.json> --dest <assets-dir> [--strict]");
    process.exit(1);
  }
  if (!existsSync(manifestPath)) {
    console.error(`manifest not found: ${manifestPath}`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`manifest is not valid JSON: ${manifestPath} — ${e.message}`);
    process.exit(1);
  }
  const results = await resolveManifest(manifest, { dest, imageGen: process.env.IMAGE_GEN || "placeholder" });
  const failed = results.filter(r => r.status === "error").length;
  console.log(`${results.length - failed}/${results.length} assets resolved → ${dest}`);
  process.exit(exitCode(results, strict));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
