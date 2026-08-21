#!/usr/bin/env node
/**
 * scripts/stable-css.mjs — postbuild. zfb emits the stylesheet as
 * `dist/assets/styles-<hash>.css` and only links it from SSG HTML. This app is
 * ~100% SSR, so the layout links `/assets/app.css` and this copies the hashed
 * output to that fixed name. The hashed original stays (long-term cacheable).
 */
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(repoRoot, "dist", "assets");
const cssFiles = readdirSync(assetsDir).filter(
  (name) => name.startsWith("styles-") && name.endsWith(".css"),
);

if (cssFiles.length !== 1) {
  console.error(
    `[stable-css] expected exactly one dist/assets/styles-*.css, found ${cssFiles.length}: ${cssFiles.join(", ")}`,
  );
  process.exit(1);
}

copyFileSync(join(assetsDir, cssFiles[0]), join(assetsDir, "app.css"));
console.log(`[stable-css] ${cssFiles[0]} -> assets/app.css`);
