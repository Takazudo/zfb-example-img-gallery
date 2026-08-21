#!/usr/bin/env node
/**
 * SSR-only invariants for this recipe.
 *
 * (1) Every page except pages/404.tsx exports the LITERAL `prerender = false`.
 *     A page that silently prerenders would be served from Static Assets with
 *     stale D1 data and would never invoke the Worker.
 * (2) dist/404.html is the only HTML file emitted — the single deliberate SSG
 *     page, required by `not_found_handling = "404-page"`.
 * (3) No client JS bundle ships and no <script> tag appears in the emitted
 *     HTML. This demo's whole point is zero client JavaScript.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative, sep } from "node:path";

const PRERENDER_FALSE = /export\s+const\s+prerender\s*=\s*false\b/;
const PAGE_EXT = /\.tsx$/;
/** The adapter's own Worker entry points — not client bundles. */
const WORKER_ENTRIES = new Set(["_worker.js", "_zfb_inner.mjs"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Returns page files that are missing the literal `prerender = false`. */
export function scanPagePrerenderExports(pagesDir = "pages") {
  const violations = [];
  for (const file of walk(pagesDir)) {
    if (!PAGE_EXT.test(file)) continue;
    const rel = relative(pagesDir, file).split(sep).join("/");
    if (rel === "404.tsx") continue; // the one permitted SSG page
    if (!PRERENDER_FALSE.test(readFileSync(file, "utf8"))) violations.push(rel);
  }
  return violations;
}

/** Returns problems found in the built output. */
export function scanBuildOutput(distDir = "dist") {
  const problems = [];
  const files = walk(distDir).map((f) => relative(distDir, f).split(sep).join("/"));

  const html = files.filter((f) => f.endsWith(".html"));
  if (html.length !== 1 || html[0] !== "404.html") {
    problems.push(`expected exactly dist/404.html, found: ${html.join(", ") || "no HTML at all"}`);
  }

  const clientJs = files.filter(
    (f) => /\.(js|mjs)$/.test(f) && !WORKER_ENTRIES.has(f.split("/").pop()),
  );
  if (clientJs.length > 0) {
    problems.push(`client JS bundle(s) emitted: ${clientJs.join(", ")}`);
  }

  for (const f of html) {
    if (/<script\b/i.test(readFileSync(join(distDir, f), "utf8"))) {
      problems.push(`${f} contains a <script> tag`);
    }
  }
  return problems;
}

function reportViolations(label, violations) {
  for (const violation of violations) console.error(`[ssr-invariant] ${label}: ${violation}`);
}

const isMain = process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const prerenderViolations = scanPagePrerenderExports();
  const buildProblems = scanBuildOutput();
  reportViolations("page", prerenderViolations);
  reportViolations("build", buildProblems);

  if (prerenderViolations.length > 0 || buildProblems.length > 0) {
    process.exitCode = 1;
  } else {
    console.log("[ssr-invariant] passed: pages are SSR-only, dist/404.html is the only HTML, and no client JavaScript was emitted");
  }
}
