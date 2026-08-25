#!/usr/bin/env node
/** Finalize zfb's generated assets and create stable SSR-facing aliases. */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GENERATED_ISLANDS_ENTRY = /^islands-(?!chunk-|resources?-).+\.js$/;
const SOURCE_MODULE = /\.(?:[cm]?[jt]sx?)$/i;

function fail(message) { throw new Error(`[stable-assets] ${message}`); }

function discoverExactlyOne(assetsDir, description, predicate) {
  const matches = readdirSync(assetsDir).filter(predicate).sort();
  if (matches.length !== 1) fail(`expected exactly one ${description}, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

export function discoverGeneratedIslandsEntry(assetsDir) {
  return discoverExactlyOne(assetsDir, "dist/assets/islands-*.js entry (excluding chunks/resources)", (name) => GENERATED_ISLANDS_ENTRY.test(name));
}

export function extractRelativeReferences(source) {
  return [...source.matchAll(/["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]).filter((reference) => !reference.startsWith("//"));
}

export function assertRelativeReferencesResolve(entryPath, source = readFileSync(entryPath, "utf8")) {
  for (const reference of extractRelativeReferences(source)) {
    const target = resolve(dirname(entryPath), reference.split(/[?#]/, 1)[0]);
    if (!existsSync(target)) fail(`${entryPath} references missing relative asset ${reference}`);
  }
}

function decodeString(raw) {
  if (raw[0] === '"') return JSON.parse(raw);
  let value = "";
  for (let i = 1; i < raw.length - 1; i += 1) {
    if (raw[i] !== "\\") { value += raw[i]; continue; }
    const escape = raw[++i];
    if (escape === undefined) fail("malformed JavaScript diagnostic string literal");
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
    if (escape in simple) value += simple[escape];
    else if (escape === "\n") continue;
    else if (escape === "\r") { if (raw[i + 1] === "\n") i += 1; }
    else if (escape === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[\da-f]{2}$/i.test(hex)) fail("malformed JavaScript diagnostic string literal");
      value += String.fromCodePoint(Number.parseInt(hex, 16)); i += 2;
    } else if (escape === "u") {
      const braced = raw[i + 1] === "{";
      const end = braced ? raw.indexOf("}", i + 2) : i + 5;
      const hex = raw.slice(i + (braced ? 2 : 1), end);
      if (end < 0 || !/^[\da-f]+$/i.test(hex) || (!braced && hex.length !== 4)) fail("malformed JavaScript diagnostic string literal");
      value += String.fromCodePoint(Number.parseInt(hex, 16)); i = end;
    } else value += escape;
  }
  return value;
}

function javascriptTokens(source) {
  const tokens = [];
  let canStartRegex = true;
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i += 1; continue; }
    if (source.startsWith("//", i)) { i = source.indexOf("\n", i + 2); if (i < 0) break; continue; }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) fail("unterminated JavaScript block comment in islands entry");
      i = end + 2; continue;
    }
    const start = i;
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++]; let escaped = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === quote) break;
        if (!escaped && (char === "\n" || char === "\r")) fail("unterminated JavaScript string in islands entry");
        if (!escaped && char === "\\") escaped = true; else escaped = false;
      }
      if (source[i - 1] !== quote) fail("unterminated JavaScript string in islands entry");
      const raw = source.slice(start, i); let value; let decodeError;
      try { value = decodeString(raw); } catch (error) { decodeError = error; }
      tokens.push({ type: "string", start, end: i, raw, value, decodeError }); canStartRegex = false; continue;
    }
    if (source[i] === "`") {
      i += 1; let escaped = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === "`") break;
        if (!escaped && char === "\\") escaped = true; else escaped = false;
      }
      if (source[i - 1] !== "`") fail("unterminated JavaScript template literal in islands entry");
      tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) }); canStartRegex = false; continue;
    }
    if (source[i] === "/" && canStartRegex) {
      i += 1; let escaped = false; let inClass = false;
      while (i < source.length) {
        const char = source[i++];
        if (!escaped && char === "[") inClass = true;
        else if (!escaped && char === "]") inClass = false;
        else if (!escaped && char === "/" && !inClass) break;
        else if (!escaped && (char === "\n" || char === "\r")) fail("unterminated JavaScript regular expression in islands entry");
        if (!escaped && char === "\\") escaped = true; else escaped = false;
      }
      while (/[a-z]/i.test(source[i] ?? "")) i += 1;
      tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) }); canStartRegex = false; continue;
    }
    if ("()[]{},;".includes(source[i])) {
      const type = source[i]; tokens.push({ type, start, end: ++i });
      canStartRegex = !")]}".includes(type); continue;
    }
    if (/[a-z_$]/i.test(source[i])) {
      i += 1; while (/[\w$]/.test(source[i] ?? "")) i += 1;
      const raw = source.slice(start, i); tokens.push({ type: "other", start, end: i, raw });
      canStartRegex = /^(?:await|case|delete|in|instanceof|new|return|throw|typeof|void|yield)$/.test(raw); continue;
    }
    if (/\d/.test(source[i])) {
      i += 1; while (/[\w.]/.test(source[i] ?? "")) i += 1;
      tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) }); canStartRegex = false; continue;
    }
    i += 1;
    while (i < source.length && !/\s|[()\[\]{},;'"`a-z_$\d]/i.test(source[i])) i += 1;
    tokens.push({ type: "other", start, end: i, raw: source.slice(start, i) }); canStartRegex = true;
  }
  return tokens;
}

function fourthCallArgumentStrings(source) {
  const tokens = javascriptTokens(source); const pairs = new Map(); const stack = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if ("([{".includes(tokens[i].type)) stack.push(i);
    else if (")]}".includes(tokens[i].type)) {
      const open = stack.pop(); if (open === undefined) fail("unbalanced JavaScript delimiters in islands entry");
      pairs.set(open, i); pairs.set(i, open);
    }
  }
  if (stack.length) fail("unbalanced JavaScript delimiters in islands entry");
  const results = [];
  for (let open = 0; open < tokens.length; open += 1) {
    if (tokens[open].type !== "(" || open === 0) continue;
    const callee = tokens[open - 1];
    if (!(callee.type === ")" || callee.type === "]" || (callee.type === "other" && /^[a-z_$][\w$]*$/i.test(callee.raw)))) continue;
    const close = pairs.get(open); if (close === undefined) continue;
    const commas = [];
    for (let i = open + 1; i < close; i += 1) {
      if ("([{".includes(tokens[i].type)) i = pairs.get(i); else if (tokens[i].type === ",") commas.push(i);
    }
    if (commas.length !== 3) continue;
    const boundaries = [open, ...commas, close];
    const args = boundaries.slice(0, -1).map((boundary, index) => tokens.slice(boundary + 1, boundaries[index + 1]));
    if (args[0].length > 0 && args[1].length === 1 && args[1][0].type === "string" && args[2].length === 1 && args[2][0].type === "string" && args[3].length === 1 && args[3][0].type === "string") results.push(args[3][0]);
  }
  return results;
}

function pathTextLooksAbsolute(value) { return value.startsWith("/") || /^[a-z]:[\\/]/i.test(value) || /^file:/i.test(value); }
function within(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function portableSourceIdentifier(value, projectRoot) {
  const slashValue = value.replaceAll("\\", "/");
  const slashRoot = projectRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const lexicalCandidates = [];
  if (/^file:/i.test(value)) {
    try { lexicalCandidates.push(fileURLToPath(value)); } catch { fail(`malformed diagnostic file URL ${value}`); }
  } else if (/^[a-z]:[\\/]/i.test(value)) {
    if (/^[a-z]:\//i.test(slashRoot) && slashValue.toLowerCase().startsWith(`${slashRoot.toLowerCase()}/`)) lexicalCandidates.push(join(projectRoot, slashValue.slice(slashRoot.length + 1)));
    if (!/^[a-z]:\//i.test(slashRoot)) lexicalCandidates.push(slashValue.slice(2));
    const segments = slashValue.split("/"); const rootName = basename(projectRoot).toLowerCase();
    segments.forEach((segment, index) => { if (segment.toLowerCase() === rootName) lexicalCandidates.push(join(projectRoot, ...segments.slice(index + 1))); });
  } else lexicalCandidates.push(value);
  const canonicalRoot = realpathSync(projectRoot); const resolved = new Set(); let sawInside = false;
  for (const candidate of lexicalCandidates) {
    const absolute = resolve(candidate); if (!within(canonicalRoot, absolute)) continue;
    sawInside = true;
    if (existsSync(absolute)) { const real = realpathSync(absolute); if (within(canonicalRoot, real)) resolved.add(real); }
  }
  if (resolved.size > 1) fail(`ambiguous diagnostic source path ${value}`);
  if (resolved.size === 0) {
    if (sawInside) fail(`unresolved diagnostic source path ${value}`);
    fail(`diagnostic source path is outside repository: ${value}`);
  }
  return relative(canonicalRoot, [...resolved][0]).split(sep).join("/");
}

export function normalizeDiagnosticSourceIdentifiers(source, projectRoot) {
  const replacements = [];
  for (const token of fourthCallArgumentStrings(source)) {
    if (token.decodeError) { if (/^["'](?:file:|\/|[a-z]:)/i.test(token.raw)) throw token.decodeError; continue; }
    if (!pathTextLooksAbsolute(token.value) || !SOURCE_MODULE.test(token.value)) continue;
    replacements.push({ ...token, replacement: JSON.stringify(portableSourceIdentifier(token.value, projectRoot)) });
  }
  let finalized = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) finalized = finalized.slice(0, replacement.start) + replacement.replacement + finalized.slice(replacement.end);
  return finalized;
}

function htmlFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(path)); else if (entry.isFile() && entry.name.endsWith(".html")) files.push(path);
  }
  return files.sort();
}
function entryReferences(html) { return [...html.matchAll(/islands-(?!chunk-|resources?-)[^"'<>\s/?#]+\.js/g)].map((match) => match[0]); }
function selectSourceEntry(assetsDir, htmlPlans) {
  const candidates = readdirSync(assetsDir).filter((name) => GENERATED_ISLANDS_ENTRY.test(name)).sort();
  const referenced = new Set(htmlPlans.flatMap(({ before }) => entryReferences(before)));
  if (referenced.size !== 1) fail(`expected exactly one generated islands entry referenced by emitted HTML, found ${referenced.size}: ${[...referenced].join(", ")}`);
  const [entry] = referenced;
  if (!candidates.includes(entry)) fail(`emitted HTML has dangling generated islands reference ${entry}`);
  return { entry, candidates };
}

export function copyStableAssets(assetsDir, projectRoot = resolve(assetsDir, "..", "..")) {
  const cssEntry = discoverExactlyOne(assetsDir, "dist/assets/styles-*.css", (name) => name.startsWith("styles-") && name.endsWith(".css"));
  const htmlPlans = htmlFiles(dirname(assetsDir)).map((path) => ({ path, before: readFileSync(path, "utf8") }));
  const { entry: oldEntry, candidates } = selectSourceEntry(assetsDir, htmlPlans);
  const oldPath = join(assetsDir, oldEntry);
  const finalizedSource = normalizeDiagnosticSourceIdentifiers(readFileSync(oldPath, "utf8"), projectRoot);
  const finalizedBytes = Buffer.from(finalizedSource);
  const hash = createHash("sha256").update(finalizedBytes).digest("hex").slice(0, 8);
  const islandsEntry = `islands-${hash}.js`; const generatedPath = join(assetsDir, islandsEntry);
  const unexpected = candidates.filter((name) => name !== oldEntry && name !== islandsEntry);
  if (unexpected.length) fail(`ambiguous generated islands entries: ${candidates.join(", ")}`);
  if (existsSync(generatedPath) && !readFileSync(generatedPath).equals(finalizedBytes)) fail(`target ${islandsEntry} already exists with different bytes`);
  assertRelativeReferencesResolve(oldPath, finalizedSource);
  const checkoutForms = [
    projectRoot,
    projectRoot.replaceAll("\\", "/"),
    projectRoot.replaceAll("/", "\\"),
    JSON.stringify(projectRoot).slice(1, -1),
    pathToFileURL(projectRoot).href,
  ];
  if (checkoutForms.some((prefix) => prefix && finalizedSource.includes(prefix))) fail("repository checkout prefix remains in finalized islands entry");
  let referenceCount = 0;
  for (const plan of htmlPlans) {
    const refs = entryReferences(plan.before);
    if (refs.some((ref) => ref !== oldEntry)) fail(`emitted HTML has dangling generated islands reference in ${plan.path}`);
    referenceCount += refs.length; plan.after = plan.before.split(oldEntry).join(islandsEntry);
    if (entryReferences(plan.after).some((ref) => ref !== islandsEntry)) fail(`failed to remove old islands reference from ${plan.path}`);
  }
  if (referenceCount === 0) fail(`expected emitted HTML reference to ${oldEntry}`);
  // The complete read/validation plan above intentionally precedes all mutation.
  if (!existsSync(generatedPath)) writeFileSync(generatedPath, finalizedBytes);
  for (const plan of htmlPlans) if (plan.after !== plan.before) writeFileSync(plan.path, plan.after);
  if (oldEntry !== islandsEntry) rmSync(oldPath);
  copyFileSync(join(assetsDir, cssEntry), join(assetsDir, "app.css"));
  writeFileSync(join(assetsDir, "islands.js"), finalizedBytes);
  if (!readFileSync(generatedPath).equals(readFileSync(join(assetsDir, "islands.js")))) fail("assets/islands.js does not match its generated entry");
  return { cssEntry, islandsEntry };
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isMain = process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const copied = copyStableAssets(join(repoRoot, "dist", "assets"), repoRoot);
    console.log(`[stable-assets] ${copied.cssEntry} -> assets/app.css`);
    console.log(`[stable-assets] finalized ${copied.islandsEntry} -> assets/islands.js`);
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
