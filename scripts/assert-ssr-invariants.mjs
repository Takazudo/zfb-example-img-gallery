#!/usr/bin/env node
/** Source and production-artifact invariants for per-request SSR + one SSG 404. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  discoverGeneratedIslandsEntry,
  extractRelativeReferences,
} from "./stable-assets.mjs";

const PRERENDER_FALSE = /export\s+const\s+prerender\s*=\s*false\b/;
const PAGE_EXT = /\.tsx$/;
const WORKER_ENTRIES = new Set(["_worker.js", "_zfb_inner.mjs"]);
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?)(?:[?#].*)?$/i;
const PORTABLE_IDENTIFIERS = [
  "components/display-settings.tsx",
  "components/infinite-gallery-controller.tsx",
  "components/theme-toggle.tsx",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function slash(path) {
  return path.split(sep).join("/");
}

export function scanPagePrerenderExports(pagesDir = "pages") {
  const violations = [];
  for (const file of walk(pagesDir)) {
    if (!PAGE_EXT.test(file)) continue;
    const rel = slash(relative(pagesDir, file));
    if (rel === "404.tsx") continue;
    if (!PRERENDER_FALSE.test(readFileSync(file, "utf8"))) violations.push(rel);
  }
  return violations;
}

function insideDist(distDir, target) {
  const rel = relative(resolve(distDir), target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function reachableClientAssets(distDir, entryRel) {
  const reachable = new Set();
  const sources = new Map();
  const problems = [];
  const seenProblems = new Set();
  const pending = [entryRel];
  const root = resolve(distDir);

  function problem(message) {
    if (!seenProblems.has(message)) {
      seenProblems.add(message);
      problems.push(message);
    }
  }

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const absolute = resolve(root, current);
    if (!insideDist(root, absolute)) {
      problem(`generated islands entry references client asset outside dist: ${current}`);
      continue;
    }

    let source;
    try {
      source = readFileSync(absolute, "utf8");
    } catch {
      problem(`generated islands entry references missing artifact: ${current}`);
      continue;
    }
    sources.set(current, source);

    for (const reference of extractRelativeReferences(source)) {
      const clean = reference.split(/[?#]/, 1)[0];
      const targetPath = resolve(dirname(absolute), clean);
      const target = slash(relative(root, targetPath));
      if (!/\.(?:js|mjs)$/.test(target)) continue;
      if (!insideDist(root, targetPath)) {
        problem(`generated islands entry references client asset outside dist: ${reference}`);
      } else {
        pending.push(target);
      }
    }
  }
  return { reachable, sources, problems };
}

function decodeString(raw) {
  if (raw[0] === '"') return JSON.parse(raw);
  let value = "";
  for (let i = 1; i < raw.length - 1; i += 1) {
    if (raw[i] !== "\\") {
      value += raw[i];
      continue;
    }
    const escape = raw[++i];
    if (escape === undefined) throw new Error("malformed string");
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
    if (escape in simple) value += simple[escape];
    else if (escape === "\n") continue;
    else if (escape === "\r") {
      if (raw[i + 1] === "\n") i += 1;
    } else if (escape === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) throw new Error("malformed string");
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 2;
    } else if (escape === "u") {
      const braced = raw[i + 1] === "{";
      const end = braced ? raw.indexOf("}", i + 2) : i + 5;
      const hex = raw.slice(i + (braced ? 2 : 1), end);
      if (end < 0 || !/^[\da-f]+$/i.test(hex) || (!braced && hex.length !== 4)) throw new Error("malformed string");
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      i = end;
    } else value += escape;
  }
  return value;
}

function javascriptTokens(source) {
  const tokens = [];
  let canStartRegex = true;
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const start = i;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++];
      let escaped = false;
      let terminated = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === quote) {
          terminated = true;
          break;
        }
        if (!escaped && (char === "\n" || char === "\r")) break;
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      if (!terminated) break;
      const raw = source.slice(start, i);
      let value;
      let decodeError;
      try {
        value = decodeString(raw);
      } catch (error) {
        decodeError = error;
      }
      tokens.push({ type: "string", start, end: i, raw, value, decodeError });
      canStartRegex = false;
      continue;
    }
    if (source[i] === "`") {
      i += 1;
      let escaped = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === "`") break;
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      canStartRegex = false;
      continue;
    }
    if (source[i] === "/" && canStartRegex) {
      i += 1;
      let escaped = false;
      let inClass = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === "[") inClass = true;
        else if (!escaped && char === "]") inClass = false;
        else if (!escaped && char === "/" && !inClass) break;
        if (!escaped && char === "\\") escaped = true;
        else escaped = false;
      }
      while (/[a-z]/i.test(source[i] ?? "")) i += 1;
      canStartRegex = false;
      continue;
    }
    if ("()[]{},;".includes(source[i])) {
      const type = source[i];
      tokens.push({ type, start, end: ++i });
      canStartRegex = !")]}".includes(type);
      continue;
    }
    if (/[a-z_$]/i.test(source[i])) {
      i += 1;
      while (/[\w$]/.test(source[i] ?? "")) i += 1;
      const raw = source.slice(start, i);
      tokens.push({ type: "other", start, end: i, raw });
      canStartRegex = /^(?:await|case|delete|in|instanceof|new|return|throw|typeof|void|yield)$/.test(raw);
      continue;
    }
    if (/\d/.test(source[i])) {
      i += 1;
      while (/[\w.]/.test(source[i] ?? "")) i += 1;
      tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) });
      canStartRegex = false;
      continue;
    }
    i += 1;
    while (i < source.length && !/\s|[()[\]{},;'"`a-z_$\d]/i.test(source[i])) i += 1;
    tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) });
    canStartRegex = true;
  }
  return tokens;
}

function isOrdinaryWebPath(value) {
  return /^\/(?:assets|static|public|images|img|fonts|favicon|robots|sitemap)(?:\/|$)/i.test(value);
}

function likelyFilesystemPosixPath(value) {
  return /^\/(?:home|users|tmp|var|private|workspace|workspaces|repo|checkout|mnt|opt|root|srv|run|build|app)(?:\/|$)/i.test(value)
    || /\/(?:components|pages|layouts|lib|src|routes)(?:\/|$)/i.test(value);
}

function scanPortableSourcePaths(assetRel, source) {
  const problems = [];
  for (const token of javascriptTokens(source)) {
    if (token.type !== "string" || token.decodeError || !token.value) continue;
    const value = token.value;
    if (!SOURCE_MODULE.test(value)) continue;
    if (/^file:/i.test(value)) {
      problems.push(`${assetRel} contains a file: source-module diagnostic: ${value}`);
    } else if (/^[a-z]:[\\/]/i.test(value)) {
      problems.push(`${assetRel} contains a Windows-drive source-module path: ${value}`);
    } else if (/^\/(?!\/)/.test(value) && !isOrdinaryWebPath(value) && likelyFilesystemPosixPath(value)) {
      problems.push(`${assetRel} contains an absolute POSIX source-module path: ${value}`);
    }
  }
  return problems;
}

function scriptTags(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(
    (match) => ({ attrs: match[1], body: match[2] }),
  );
}

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1];
}

function scanSsg404(html, generatedEntry) {
  const problems = [];
  const scripts = scriptTags(html);
  const bootstrap = scripts.filter(({ attrs }) => /\bdata-theme-bootstrap\b/i.test(attrs));
  const jsonLd = scripts.filter(({ attrs }) => attribute(attrs, "type") === "application/ld+json");
  const modules = scripts.filter(({ attrs }) => attribute(attrs, "type") === "module");
  const otherExecutable = scripts.filter(
    (script) => !bootstrap.includes(script) && !jsonLd.includes(script) && !modules.includes(script),
  );

  if (bootstrap.length !== 1 || !bootstrap[0]?.body.trim()) {
    problems.push(`404.html must contain exactly one non-empty marked theme bootstrap, found ${bootstrap.length}`);
  }
  const stylesheetIndex = html.indexOf('href="/assets/app.css"');
  const bootstrapIndex = html.indexOf("data-theme-bootstrap");
  if (stylesheetIndex < 0 || html.match(/href=["']\/assets\/app\.css["']/g)?.length !== 1) {
    problems.push("404.html must contain exactly one /assets/app.css link");
  } else if (bootstrapIndex < 0 || bootstrapIndex > stylesheetIndex) {
    problems.push("404.html theme bootstrap must precede /assets/app.css");
  }

  const moduleSources = modules.map(({ attrs }) => attribute(attrs, "src"));
  if (
    moduleSources.length !== 1
    || !moduleSources[0]?.match(/^\/assets\/islands-(?!chunk-|resources?-).+\.js$/)
  ) {
    problems.push(`404.html must load one hashed islands module, found: ${moduleSources.join(", ") || "none"}`);
  }
  if (generatedEntry && moduleSources.length === 1) {
    const expected = `/assets/${generatedEntry}`;
    if (moduleSources[0] !== expected) {
      problems.push(`404.html must reference the finalized generated islands entry ${expected}, found: ${moduleSources[0]}`);
    }
  }
  if (moduleSources.includes("/assets/islands.js")) {
    problems.push("404.html must not load the stable /assets/islands.js alias");
  }
  if (otherExecutable.length > 0 || modules.some(({ body }) => body.trim())) {
    problems.push("404.html contains an unexpected executable or inline module script");
  }

  for (const marker of [
    'name="zfb-view-transitions-enabled" content="true"',
    'name="zfb-view-transitions-fallback" content="animate"',
    'name="zfb-preserve-html-attrs" content="data-theme data-thumb-ratio data-thumb-width data-gallery-layout"',
    'name="zfb-traverse-refetch" content="true"',
    ".zfb-route-announcer",
    'data-zfb-island="ThemeToggle" data-when="load"',
    'data-zfb-island="DisplaySettings" data-when="load"',
    '<dialog aria-labelledby="display-settings-title"',
    '<legend',
  ]) {
    if (!html.includes(marker)) problems.push(`404.html is missing ${marker}`);
  }
  if (html.includes('aria-haspopup="dialog"')) {
    problems.push("404.html must withhold the display-settings trigger until hydration");
  }
  if (html.match(/name=["']thumbnail-ratio["']/g)?.length !== 4) {
    problems.push("404.html must contain four thumbnail-ratio radios");
  }
  if (html.match(/name=["']thumbnail-width["']/g)?.length !== 3) {
    problems.push("404.html must contain three thumbnail-width radios");
  }
  if (html.match(/name=["']gallery-layout["']/g)?.length !== 5) {
    problems.push("404.html must contain five gallery-layout radios");
  }
  if (html.match(/<fieldset\b/gi)?.length !== 3 || html.match(/<legend\b/gi)?.length !== 3) {
    problems.push("404.html must contain three labelled display-settings fieldsets");
  }
  if (html.match(/<input\b[^>]*type=["']radio["']/gi)?.length !== 12) {
    problems.push("404.html must contain twelve display-settings radios");
  }
  return problems;
}

export function scanBuildOutput(distDir = "dist") {
  const problems = [];
  const files = walk(distDir).map((file) => slash(relative(distDir, file))).sort();
  const htmlFiles = files.filter((file) => file.endsWith(".html"));
  if (htmlFiles.length !== 1 || htmlFiles[0] !== "404.html") {
    problems.push(`expected exactly dist/404.html, found: ${htmlFiles.join(", ") || "no HTML at all"}`);
  }

  const assetsDir = join(distDir, "assets");
  let generatedEntry;
  try {
    generatedEntry = discoverGeneratedIslandsEntry(assetsDir);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const stableEntry = "assets/islands.js";
  if (!files.includes(stableEntry)) problems.push(`missing ${stableEntry}`);
  if (generatedEntry) {
    const generatedRel = `assets/${generatedEntry}`;
    if (!files.includes(generatedRel)) {
      problems.push(`missing generated islands entry: ${generatedRel}`);
    } else {
      const generatedBytes = readFileSync(join(distDir, generatedRel));
      if (files.includes(stableEntry)) {
        const stableBytes = readFileSync(join(distDir, stableEntry));
        if (!generatedBytes.equals(stableBytes)) {
          problems.push(`${stableEntry} bytes differ from ${generatedRel}`);
        }
      }

      const expectedHash = createHash("sha256").update(generatedBytes).digest("hex").slice(0, 8);
      const expectedEntry = `islands-${expectedHash}.js`;
      if (generatedEntry !== expectedEntry) {
        problems.push(`generated islands entry filename ${generatedEntry} does not match final-byte SHA-256; expected ${expectedEntry}`);
      }

      const entrySource = generatedBytes.toString("utf8");
      for (const identifier of PORTABLE_IDENTIFIERS) {
        if (!entrySource.includes(identifier)) {
          problems.push(`generated islands entry is missing portable source identifier: ${identifier}`);
        }
      }

      const graph = reachableClientAssets(distDir, generatedRel);
      problems.push(...graph.problems);
      for (const [assetRel, source] of graph.sources) {
        problems.push(...scanPortableSourcePaths(assetRel, source));
      }

      const emittedClientJs = files.filter(
        (file) => /\.(?:js|mjs)$/.test(file) && !WORKER_ENTRIES.has(file),
      );
      const expectedClientJs = new Set(graph.reachable);
      if (files.includes(stableEntry)) expectedClientJs.add(stableEntry);
      for (const file of emittedClientJs) {
        if (!expectedClientJs.has(file)) problems.push(`unexpected client JavaScript artifact: ${file}`);
      }
      for (const file of expectedClientJs) {
        if (!files.includes(file)) problems.push(`generated islands entry references missing artifact: ${file}`);
      }
    }
  }

  if (htmlFiles.includes("404.html")) {
    problems.push(...scanSsg404(readFileSync(join(distDir, "404.html"), "utf8"), generatedEntry));
  }
  return problems;
}

function reportViolations(label, violations) {
  for (const violation of violations) console.error(`[ssr-invariant] ${label}: ${violation}`);
}

const isMain = process.argv[1]
  && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const prerenderViolations = scanPagePrerenderExports();
  const buildProblems = scanBuildOutput();
  reportViolations("page", prerenderViolations);
  reportViolations("build", buildProblems);
  if (prerenderViolations.length > 0 || buildProblems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("[ssr-invariant] passed: per-request pages, one SSG 404, and exact reachable client runtime inventory verified");
  }
}
