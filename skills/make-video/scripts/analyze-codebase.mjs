#!/usr/bin/env node
// Stage 0 — INGEST: deterministic codebase analyzer.
// Usage: node analyze-codebase.mjs <repo-path> [--out facts.json]
// Emits a facts.json that grounds every on-screen claim in the generated video.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, extname, basename, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "vendor", ".next", ".venv",
  "venv", "__pycache__", ".cache", "coverage", ".idea", ".vscode", "renders",
  ".hyperframes", ".claude", ".agent",
]);
const LANG_BY_EXT = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".mjs": "JavaScript",
  ".cjs": "JavaScript", ".jsx": "JavaScript", ".py": "Python", ".rs": "Rust",
  ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".rb": "Ruby",
  ".php": "PHP", ".cs": "C#", ".cpp": "C++", ".c": "C", ".h": "C/C++ header",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".md": "Markdown", ".json": "JSON",
  ".yml": "YAML", ".yaml": "YAML", ".sh": "Shell", ".sql": "SQL", ".vue": "Vue",
  ".svelte": "Svelte", ".dart": "Dart", ".ex": "Elixir", ".exs": "Elixir",
};

export function walk(dir, depth = 0, acc = { files: [], dirs: [] }) {
  if (depth > 8) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.isDirectory() && e.name !== ".github") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      acc.dirs.push(p);
      walk(p, depth + 1, acc);
    } else if (e.isFile()) {
      acc.files.push(p);
    }
  }
  return acc;
}

export function countLines(file) {
  try {
    const s = statSync(file);
    if (s.size > 2_000_000) return 0; // skip huge/binary-ish files
    const buf = readFileSync(file);
    if (buf.includes(0)) return 0; // binary
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return n + 1;
  } catch { return 0; }
}

// README content → {firstParagraph, headings, bullets}. Fenced code blocks are
// stripped first so bash comments aren't mistaken for headings.
export function readmeFactsFrom(content, fileName) {
  const prose = content.replace(/```[\s\S]*?```/g, "");
  const lines = prose.split("\n");
  const headings = lines.filter(l => /^#{1,3}\s/.test(l)).map(l => l.replace(/^#+\s*/, "")).slice(0, 12);
  const firstPara = content
    .replace(/^#.*$/m, "")
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .find(s => s && !s.startsWith("#") && !s.startsWith("![") && !s.startsWith("<") && s.length > 40) || null;
  const bullets = lines.filter(l => /^\s*[-*]\s+\S/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, "").trim()).slice(0, 20);
  return { file: fileName, firstParagraph: firstPara, headings, bullets };
}

export function analyze(repo) {
  repo = resolve(repo);
  if (!existsSync(repo)) throw new Error(`repo path not found: ${repo}`);

  function git(...cmdArgs) {
    try {
      return execFileSync("git", ["-C", repo, ...cmdArgs], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch { return null; }
  }

  function readIfExists(...names) {
    for (const n of names) {
      const p = join(repo, n);
      if (existsSync(p)) {
        try { return { name: n, content: readFileSync(p, "utf8") }; } catch { /* skip */ }
      }
    }
    return null;
  }

  const { files, dirs } = walk(repo);

  const langLines = {};
  let totalLines = 0;
  for (const f of files) {
    const lang = LANG_BY_EXT[extname(f).toLowerCase()];
    if (!lang) continue;
    const n = countLines(f);
    if (!n) continue;
    langLines[lang] = (langLines[lang] || 0) + n;
    totalLines += n;
  }
  const languages = Object.entries(langLines)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, lines]) => ({ lang, lines, pct: +(100 * lines / Math.max(totalLines, 1)).toFixed(1) }));

  // manifests
  const pkg = readIfExists("package.json");
  const pyproject = readIfExists("pyproject.toml");
  const cargo = readIfExists("Cargo.toml");
  const gomod = readIfExists("go.mod");
  let manifest = null;
  if (pkg) {
    try {
      const j = JSON.parse(pkg.content);
      manifest = {
        kind: "npm", name: j.name, version: j.version, description: j.description,
        dependencies: Object.keys(j.dependencies || {}),
        devDependencies: Object.keys(j.devDependencies || {}),
        scripts: Object.keys(j.scripts || {}),
      };
    } catch { /* unparseable */ }
  } else if (cargo) {
    const name = cargo.content.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const desc = cargo.content.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
    manifest = { kind: "cargo", name, description: desc };
  } else if (pyproject) {
    const name = pyproject.content.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const desc = pyproject.content.match(/^description\s*=\s*"([^"]+)"/m)?.[1];
    manifest = { kind: "python", name, description: desc };
  } else if (gomod) {
    manifest = { kind: "go", name: gomod.content.match(/^module\s+(\S+)/m)?.[1] };
  }

  // README: first paragraph + headings + bullet "features"
  const readme = readIfExists("README.md", "README.rst", "README.txt", "readme.md");
  const readmeFacts = readme ? readmeFactsFrom(readme.content, readme.name) : null;

  // git stats
  let gitFacts = null;
  if (git("rev-parse", "--is-inside-work-tree") === "true") {
    const commitCount = git("rev-list", "--count", "HEAD");
    gitFacts = {
      commits: commitCount ? +commitCount : null,
      firstCommit: git("log", "--reverse", "--format=%as")?.split("\n")[0] ?? null,
      lastCommit: git("log", "-1", "--format=%as"),
      contributors: git("shortlog", "-sn", "HEAD")?.split("\n").filter(Boolean).length ?? null,
      branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    };
  }

  // notable top-level structure
  const topLevel = readdirSync(repo, { withFileTypes: true })
    .filter(e => !e.name.startsWith(".") && !IGNORE_DIRS.has(e.name))
    .map(e => e.name + (e.isDirectory() ? "/" : ""))
    .sort();

  return {
    // deterministic: derived from repo state, not wall clock (facts.json must be cache-stable)
    generatedAt: gitFacts?.lastCommit ?? null,
    repoPath: repo,
    name: manifest?.name || basename(repo),
    description: manifest?.description || readmeFacts?.firstParagraph || null,
    manifest,
    metrics: {
      files: files.length,
      directories: dirs.length,
      linesOfCode: totalLines,
      languages,
    },
    git: gitFacts,
    readme: readmeFacts,
    topLevel,
  };
}

function main() {
  const args = process.argv.slice(2);
  const repo = resolve(args[0] || ".");
  const outIdx = args.indexOf("--out");
  const outPath = outIdx > -1 ? args[outIdx + 1] : join(process.cwd(), "facts.json");

  if (!existsSync(repo)) {
    console.error(`repo path not found: ${repo}`);
    process.exit(1);
  }
  const facts = analyze(repo);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, JSON.stringify(facts, null, 2));
  console.log(`facts written → ${outPath}`);
  console.log(`  ${facts.name}: ${facts.metrics.files} files, ${facts.metrics.linesOfCode} LOC, top langs: ${facts.metrics.languages.slice(0, 3).map(l => l.lang).join(", ") || "n/a"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
