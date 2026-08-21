import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
export const DEFAULT_PHOTOS_DIR = path.join(REPO_ROOT, "data", "photos");
export const DEFAULT_MANIFEST = path.join(DEFAULT_PHOTOS_DIR, "manifest.json");
export const DEFAULT_WRANGLER_CONFIG = path.join(REPO_ROOT, "wrangler.toml");
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_TAGS = 10;
export const MAX_TAG_CODEPOINTS = 32;

const SAFE_SQL_LITERAL = /^[A-Za-z0-9/_.-]+$/u;
const SERVABLE_PHOTO_KEY =
  /^photos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function manifestError(message) {
  return new Error(`Manifest validation failed: ${message}`);
}

function entryLabel(entry, index) {
  const slug = entry && typeof entry === "object" && typeof entry.slug === "string" ? entry.slug : "?";
  return `entry ${index + 1}${slug === "?" ? "" : ` (${slug})`}`;
}

function resolveManifestPath(value, fallback, repoRoot = REPO_ROOT) {
  if (value === undefined || value === null || value === "") return path.resolve(fallback);
  if (typeof value !== "string") throw manifestError(`path field must be a string, got ${valueType(value)}`);
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function explicitPath(entry, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(entry, name)) return entry[name];
  }
  return undefined;
}

function assertEntryShape(entry, index) {
  const label = entryLabel(entry, index);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw manifestError(`${label} must be an object`);
  }
  for (const field of ["slug", "title", "description", "tags"]) {
    if (!(field in entry)) throw manifestError(`${label} is missing ${field}`);
  }
  for (const field of ["slug", "title", "description"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      throw manifestError(`${label} ${field} must be a non-empty string`);
    }
  }
  if (entry.slug.includes("/") || entry.slug.includes("\\") || entry.slug === "." || entry.slug === "..") {
    throw manifestError(`${label} slug is not a safe path segment: ${JSON.stringify(entry.slug)}`);
  }
  if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
    throw manifestError(`${label} tags must be an array of strings`);
  }
}

async function inspectFile(filePath, label) {
  try {
    const details = await stat(filePath);
    if (!details.isFile()) return { path: filePath, size: null, error: `${label} is not a regular file: ${filePath}` };
    if (details.size === 0) return { path: filePath, size: 0, error: `${label} is empty: ${filePath}` };
    return { path: filePath, size: details.size, error: null };
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
    return { path: filePath, size: null, error: `${label} is missing: ${filePath}${reason}` };
  }
}

/**
 * Read and validate the checked-in photo manifest.
 *
 * The generated manifest is an object with a `photos` array.  Accepting a
 * bare array as well keeps the helper compatible with the compact contract
 * used by the seed task and makes small local fixtures convenient.
 *
 * `checkFiles` defaults to true for defensive callers.  The seeder and
 * backfill pass false so a deliberately broken individual item can be
 * reported and skipped while the rest of a run continues.
 */
export async function readManifest(
  manifestPath = DEFAULT_MANIFEST,
  photosDir = DEFAULT_PHOTOS_DIR,
  { checkFiles = true, repoRoot = REPO_ROOT } = {},
) {
  const resolvedManifest = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(repoRoot, manifestPath);
  const resolvedPhotosDir = path.isAbsolute(photosDir) ? photosDir : path.resolve(repoRoot, photosDir);

  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolvedManifest, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw manifestError(`could not read or parse ${resolvedManifest}: ${reason}`);
  }

  const entries = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.photos) ? parsed.photos : null;
  if (!entries || entries.length === 0) {
    throw manifestError("expected a non-empty array or an object with a non-empty photos array");
  }

  const titles = new Map();
  const result = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assertEntryShape(entry, index);
    if (titles.has(entry.title)) {
      throw manifestError(
        `title is not unique: ${JSON.stringify(entry.title)} (${titles.get(entry.title)} and ${entry.slug})`,
      );
    }
    titles.set(entry.title, entry.slug);

    const originalPath = resolveManifestPath(
      explicitPath(entry, ["localPath", "fullPath", "originalPath"]),
      path.join(resolvedPhotosDir, "2000w", `${entry.slug}.webp`),
      repoRoot,
    );
    const thumbPath = resolveManifestPath(
      explicitPath(entry, ["thumbLocalPath", "thumbPath", "thumbnailPath"]),
      path.join(resolvedPhotosDir, "600w", `${entry.slug}.webp`),
      repoRoot,
    );
    const [original, thumb] = await Promise.all([
      inspectFile(originalPath, `${entry.slug} original`),
      inspectFile(thumbPath, `${entry.slug} thumbnail`),
    ]);
    const fileErrors = [original.error, thumb.error].filter(Boolean);
    const tooLarge = original.size !== null && original.size >= MAX_UPLOAD_BYTES;
    result.push({
      ...entry,
      fullPath: original.path,
      thumbPath: thumb.path,
      originalBytes: original.size,
      thumbBytes: thumb.size,
      fileErrors,
      fileError: fileErrors[0] ?? null,
      tooLarge,
    });
  }

  if (checkFiles) {
    const firstFileError = result.find((entry) => entry.fileErrors.length > 0);
    if (firstFileError) {
      throw manifestError(firstFileError.fileErrors[0]);
    }
  }
  return result;
}

/** Apply the upload route's canonical tag rules before a browser submission. */
export function prepareTags(input) {
  const values = (Array.isArray(input) ? input : [input]).flatMap((value) => String(value ?? "").split(","));
  const tags = [];
  const seen = new Set();
  for (const rawValue of values) {
    let value = rawValue.trim();
    if (value.startsWith("#")) value = value.slice(1);
    value = value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, "-");
    if (
      value === "" ||
      /[/%?#]/u.test(value) ||
      CONTROL_CHARACTERS.test(value) ||
      [...value].length < 1 ||
      [...value].length > MAX_TAG_CODEPOINTS ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    tags.push(value);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** Alias matching the server-side terminology used by a few callers. */
export const normalizeSeedTags = prepareTags;

/** Derive the route-valid thumbnail key without making it filename-dependent. */
export function deriveThumbKey(r2Key) {
  if (typeof r2Key !== "string") throw new Error(`r2_key must be a string, got ${valueType(r2Key)}`);
  const match = SERVABLE_PHOTO_KEY.exec(r2Key);
  if (!match) throw new Error(`Cannot derive thumbnail key from invalid original key: ${JSON.stringify(r2Key)}`);
  return `thumbs/${match[1]}.webp`;
}

/** Guard values interpolated into the one batched D1 UPDATE statement. */
export function assertSqlLiteral(value, label = "SQL literal") {
  if (typeof value !== "string" || !SAFE_SQL_LITERAL.test(value)) {
    throw new Error(`${label} contains unsafe characters: ${JSON.stringify(value)}`);
  }
  return value;
}

export function sqlLiteral(value, label = "SQL literal") {
  return `'${assertSqlLiteral(value, label)}'`;
}

/** Read the first string-valued key from the simple Wrangler TOML config. */
export async function readWranglerValue(key, configPath = DEFAULT_WRANGLER_CONFIG) {
  const contents = await readFile(configPath, "utf8");
  const expression = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*[\"']([^\"']+)[\"']\\s*$`, "m");
  const match = expression.exec(contents);
  if (!match) throw new Error(`Could not find ${key} in ${configPath}`);
  return match[1];
}
