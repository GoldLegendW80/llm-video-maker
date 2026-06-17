# LLM Video Maker

Agent skills that turn a **video brief** (or a plain description) into a **fully rendered MP4** —
LLM-authored HTML/GSAP compositions rendered deterministically with the
[HyperFrames](https://www.npmjs.com/package/hyperframes) engine.

Two skills ship here:

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **make-video** | `/make-video <brief.json \| description>` | Full pipeline: brief → research/facts → design → storyboard → assets (icons, logos, stock, TTS narration, captions) → HTML composition → validate → render MP4 → QA report. |
| **edit-video** | `/edit-video <id> <chapter> '<instruction>'` | Chapter-scoped edits of a finished video — re-storyboards and re-renders only the scenes in one chapter. |

Square / vertical / landscape, audio-first TTS or transcript-locked user audio, captions, music,
real-asset fetching, and a hard validation gate (lint · contrast · layout · vision pass) before render.

## Install

```bash
# Both skills, into your coding agent (Claude Code, Cursor, Codex, …)
npx skills add GoldLegendW80/llm-video-maker

# Or just one
npx skills add GoldLegendW80/llm-video-maker --skill make-video
npx skills add GoldLegendW80/llm-video-maker --list
```

`npx skills add` copies each `skills/<name>/SKILL.md` plus its bundled `scripts/` and `schema.json`
into your agent's skills directory. See [skills.sh](https://www.skills.sh) for the ecosystem.

## Prerequisites

The skills are self-contained (pipeline scripts are bundled), but the **runtime** they drive needs:

- **Node ≥ 22**, **FFmpeg/FFprobe**, and **Google Chrome** (verified by `npx hyperframes@0.6.91 doctor`).
- **HyperFrames `0.6.91` exact** — pin it in your host repo: `npm i -D hyperframes@0.6.91`
  (never float a pre-1.0 engine; the project's `package.json` records the version that rendered it).
- **Companion authoring skills** (hyperframes, gsap, css-animations, …) — installed once with
  `npx hyperframes@0.6.91 skills`.
- **Optional**, only for the `capture` asset type: `npm i -D playwright-core` (drives your installed Chrome).
- **Optional API keys** (all free tiers) unlock more assets — `PEXELS_API_KEY` / `PIXABAY_API_KEY`
  (stock photos + video), `GIPHY_API_KEY` / `TENOR_API_KEY` (gifs), `FREESOUND_API_KEY` (CC0 SFX),
  `OPENAI_API_KEY` + `IMAGE_GEN=openai` (real image generation). Without keys the pipeline still
  delivers using keyless routes (Iconify icons, simple-icons brand logos, `web` CC sources, memes,
  live `capture`) and styled placeholders.

### Text-to-speech (Kokoro) — one-time setup + a known patch

Audio-first narration (`narration.mode: "tts"`) uses the local **Kokoro-82M** model. The desktop app
bundles a prewarmed environment; a CLI user provisions it once:

```bash
uv venv ~/.video-maker/runtime/python
uv pip install --python ~/.video-maker/runtime/python/bin/python kokoro-onnx soundfile
# (no uv? python3 -m venv … then pip install kokoro-onnx soundfile)
```

The Kokoro model files (`kokoro-v1.0.onnx` + `voices-v1.0.bin`) must already be present under
`~/.cache/hyperframes/tts/` — never download them mid-run.

> **Known issue (kokoro-onnx 0.5.0):** for models exposing an `input_ids` input it sends `speed` as
> `int32` where the ONNX model expects `float`, and `create()` returns audio shaped `(1, N)` which
> `soundfile.write` rejects. If synthesis fails with `Unexpected input data type` or
> `Format not recognised`, patch the venv's `kokoro_onnx/__init__.py` (`np.int32` → `np.float32` on
> the `speed` line) and `np.squeeze(...)` the samples before writing.

Captions need word-level timestamps; if no multilingual Whisper model is provisioned, caption timing
falls back to deterministic syllable-weighted distribution (verbatim text preserved, timing approximate).

## Quick start

```bash
# 1. fast hello-world render (no LLM, ~3 min)
cd <a hyperframes project> && npm install && npx hyperframes render

# 2. from your agent
/make-video briefs/my-brief.json
# or just describe it:
/make-video "30s square promo for <X>, funny, high energy, French voiceover"
```

The input contract is [`skills/make-video/schema.json`](skills/make-video/schema.json): required
`id`, `platform` (tiktok|reels|shorts|youtube|square|custom), `story`, `source`
(`codebase` / `topic` / `script`). Everything else (narration, captions, music, style, output) is optional.

## How it works (stages)

`preflight → ingest → design → storyboard → assets → compose → validate → render → QA report`

Every stage writes its artifact into `projects/<id>/` so runs are resumable and auditable; re-running
resumes from the first stale stage. The validation gate (lint, WCAG contrast, layout inspect, vision
pass) is not skippable. All assets are vendored locally with license sidecars — no network at render time.

## Responsible use

These skills can produce marketing/promotional content. You are responsible for the claims, brand
marks, and regulatory disclaimers in whatever you generate (e.g. gambling ads require jurisdiction-
specific age/risk warnings). The pipeline grounds on-screen facts to a `facts.json` and travels asset
licensing with each project, but final compliance and rights clearance are yours.

## License

MIT — see [LICENSE](LICENSE).
