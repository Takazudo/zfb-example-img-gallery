#!/usr/bin/env node
/** Source and production-artifact invariants for per-request SSR + one SSG 404. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  discoverGeneratedIslandsEntry,
  extractRelativeReferences,
} from "./stable-assets.mjs";

const PRERENDER_FALSE = /export\s+const\s+prerender\s*=\s*false\b/;
const PAGE_EXT = /\.tsx$/;
const WORKER_ENTRIES = new Set(["_worker.js", "_zfb_inner.mjs"]);

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

function reachableClientAssets(distDir, entryRel) {
  const reachable = new Set();
  const pending = [entryRel];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    const source = readFileSync(join(distDir, current), "utf8");
    for (const reference of extractRelativeReferences(source)) {
      const clean = reference.split(/[?#]/, 1)[0];
      const target = slash(relative(distDir, resolve(dirname(join(distDir, current)), clean)));
      if (/\.(?:js|mjs)$/.test(target)) pending.push(target);
    }
  }
  return reachable;
}

function scriptTags(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(
    (match) => ({ attrs: match[1], body: match[2] }),
  );
}

function attribute(attrs, name) {
  return attrs.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1];
}

function scanSsg404(html) {
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
  if (moduleSources.includes("/assets/islands.js")) {
    problems.push("404.html must not load the stable /assets/islands.js alias");
  }
  if (otherExecutable.length > 0 || modules.some(({ body }) => body.trim())) {
    problems.push("404.html contains an unexpected executable or inline module script");
  }

  for (const marker of [
    'name="zfb-view-transitions-enabled" content="true"',
    'name="zfb-view-transitions-fallback" content="animate"',
    'name="zfb-preserve-html-attrs" content="data-theme"',
    'name="zfb-traverse-refetch" content="true"',
    ".zfb-route-announcer",
    'data-zfb-island="ThemeToggle" data-when="load"',
  ]) {
    if (!html.includes(marker)) problems.push(`404.html is missing ${marker}`);
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
  if (generatedEntry && files.includes(stableEntry)) {
    const generatedRel = `assets/${generatedEntry}`;
    if (!readFileSync(join(distDir, generatedRel)).equals(readFileSync(join(distDir, stableEntry)))) {
      problems.push(`${stableEntry} bytes differ from ${generatedRel}`);
    }

    const reachable = reachableClientAssets(distDir, generatedRel);
    const emittedClientJs = files.filter(
      (file) => /\.(?:js|mjs)$/.test(file) && !WORKER_ENTRIES.has(file),
    );
    const expectedClientJs = new Set([...reachable, stableEntry]);
    for (const file of emittedClientJs) {
      if (!expectedClientJs.has(file)) problems.push(`unexpected client JavaScript artifact: ${file}`);
    }
    for (const file of expectedClientJs) {
      if (!files.includes(file)) problems.push(`generated islands entry references missing artifact: ${file}`);
    }
  }

  if (htmlFiles.includes("404.html")) {
    problems.push(...scanSsg404(readFileSync(join(distDir, "404.html"), "utf8")));
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
