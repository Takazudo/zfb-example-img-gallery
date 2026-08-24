#!/usr/bin/env node
/** Copy zfb's hashed stylesheet and islands entry to stable SSR-facing URLs. */
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_ISLANDS_ENTRY = /^islands-(?!chunk-|resources?-).+\.js$/;

function discoverExactlyOne(assetsDir, description, predicate) {
  const matches = readdirSync(assetsDir).filter(predicate).sort();
  if (matches.length !== 1) {
    throw new Error(
      `[stable-assets] expected exactly one ${description}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return matches[0];
}

export function discoverGeneratedIslandsEntry(assetsDir) {
  return discoverExactlyOne(
    assetsDir,
    "dist/assets/islands-*.js entry (excluding chunks/resources)",
    (name) => GENERATED_ISLANDS_ENTRY.test(name),
  );
}

/** Return local relative references embedded in an emitted ESM entry. */
export function extractRelativeReferences(source) {
  return [...source.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith("//"));
}

export function assertRelativeReferencesResolve(entryPath) {
  const source = readFileSync(entryPath, "utf8");
  for (const reference of extractRelativeReferences(source)) {
    const cleanReference = reference.split(/[?#]/, 1)[0];
    const target = resolve(dirname(entryPath), cleanReference);
    if (!existsSync(target)) {
      throw new Error(
        `[stable-assets] ${entryPath} references missing relative asset ${reference}`,
      );
    }
  }
}

export function copyStableAssets(assetsDir) {
  const cssEntry = discoverExactlyOne(
    assetsDir,
    "dist/assets/styles-*.css",
    (name) => name.startsWith("styles-") && name.endsWith(".css"),
  );
  const islandsEntry = discoverGeneratedIslandsEntry(assetsDir);
  const generatedIslandsPath = join(assetsDir, islandsEntry);

  assertRelativeReferencesResolve(generatedIslandsPath);
  copyFileSync(join(assetsDir, cssEntry), join(assetsDir, "app.css"));
  copyFileSync(generatedIslandsPath, join(assetsDir, "islands.js"));

  const generatedBytes = readFileSync(generatedIslandsPath);
  const stableBytes = readFileSync(join(assetsDir, "islands.js"));
  if (!generatedBytes.equals(stableBytes)) {
    throw new Error("[stable-assets] assets/islands.js does not match its generated entry");
  }

  return { cssEntry, islandsEntry };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMain = process.argv[1]
  && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const copied = copyStableAssets(join(repoRoot, "dist", "assets"));
    console.log(`[stable-assets] ${copied.cssEntry} -> assets/app.css`);
    console.log(`[stable-assets] ${copied.islandsEntry} -> assets/islands.js`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
