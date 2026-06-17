# LLM Video Maker

[![skills.sh](https://skills.sh/b/GoldLegendW80/llm-video-maker)](https://skills.sh/GoldLegendW80/llm-video-maker)

Tell your AI coding agent what video you want — it writes the script, builds the visuals, adds
voiceover, captions and music, and renders a finished **MP4**. Powered by the
[HyperFrames](https://www.npmjs.com/package/hyperframes) engine. Two skills for
[skills.sh](https://www.skills.sh).

## 1. Install

```bash
npx skills add GoldLegendW80/llm-video-maker
```

That's it. This copies both skills into your agent (Claude Code, Cursor, Codex, Windsurf, …).

## 2. Use

Just ask your agent:

```
/make-video "30s square promo for my app — funny, high energy, French voiceover"
```

…or give it a JSON brief. To change one part of a finished video:

```
/edit-video <project-id> <chapter> "make the intro punchier"
```

**You don't download or wire up anything by hand — the skill sets up its own tools the first time it
runs.** Output lands in `projects/<id>/` (the MP4, plus every intermediate file, so runs are
resumable).

## What the skill pulls in for you (automatic, first run)

| What | Where | Why |
|------|-------|-----|
| HyperFrames engine `hyperframes@0.6.91` | your project's `node_modules/` | renders the HTML composition into an MP4 |
| Companion skills (hyperframes, gsap, css-animations…) | `.agents/skills/` (gitignored) | authoring know-how the pipeline reads |
| Icons, brand logos, stock media, captions | `projects/<id>/assets/` | the on-screen visuals, saved locally with their licenses |

Everything is fetched at build time and reused after. **Nothing accesses the network while rendering.**

## What you need on your machine first

Three system tools the skill can't install for you (it checks them and stops early if one is missing,
via `npx hyperframes@0.6.91 doctor`):

- **Node ≥ 22** · **FFmpeg** · **Google Chrome**

macOS: `brew install node ffmpeg` and install Chrome normally.

## AI voiceover (optional)

Narration uses a **local, offline** text-to-speech model (Kokoro — no API key, nothing leaves your
machine). **The agent sets this up itself.** The only one-time cost is a ~80 MB voice-model download
the first time, which the agent runs or walks you through — it won't silently stall a render.

Don't want voiceover? Skip it entirely — use music + captions, or supply your own recording.

## Optional — richer assets (free API keys)

Set any of these in your environment and the pipeline grabs real media instead of styled placeholders.
All have free tiers; skip them and it still produces a finished video from built-in icons + logos.

| Key | Unlocks |
|-----|---------|
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` | stock photos + video b-roll |
| `GIPHY_API_KEY` / `TENOR_API_KEY` | reaction gifs |
| `FREESOUND_API_KEY` | CC0 sound effects |
| `OPENAI_API_KEY` + `IMAGE_GEN=openai` | AI image generation |

## The two skills

| Skill | Trigger | What it does |
|-------|---------|--------------|
| **make-video** | `/make-video <brief.json \| description>` | brief → research → design → storyboard → assets → compose → validate → MP4 + report |
| **edit-video** | `/edit-video <id> <chapter> '<instruction>'` | re-renders only the scenes in one chapter of a finished video |

Input format: [`skills/make-video/schema.json`](skills/make-video/schema.json). Required fields are just
`id`, `platform`, `story`, `source` — everything else (voiceover, captions, music, style) is optional.

## Responsible use

You're responsible for the claims, brand marks, and legal disclaimers in whatever you generate (e.g.
gambling or finance ads need jurisdiction-specific age/risk warnings). The pipeline grounds on-screen
facts and tracks each asset's license, but rights clearance and compliance are on you.

## License

MIT — see [LICENSE](LICENSE).
