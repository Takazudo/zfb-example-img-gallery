import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { statSync as requireStat } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { env, pipeline, RawImage } from "@huggingface/transformers";

import { DEAD_SLUGS, parseSlug, tagsFromSlug, titleFromSlug } from "./lib/slug-taxonomy.mjs";

export const MODEL_ID = "Xenova/siglip-base-patch16-384";
export const MARGIN_THRESHOLD = 0.005;

export const FACETS = {
  form: [
    "an enclosure",
    "a case",
    "a front panel",
    "a blank panel",
    "a rail",
    "a stand",
    "a block",
    "a sheet",
    "a bracket",
    "a set of hardware",
  ],
  material: ["3d printed", "acrylic", "aluminium", "wooden", "steel"],
  view: ["single item", "pair", "group", "macro", "angled view", "front view", "assembled build"],
  finish: ["matte", "glossy", "transparent", "brushed"],
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PHOTO_DIR = path.join(REPO_ROOT, "data", "photos");
const SLUG_FILE = path.join(PHOTO_DIR, "slugs.txt");
const DEFAULT_OUT = path.join(PHOTO_DIR, "manifest.json");
const MAX_BYTES = 4 * 1024 * 1024;

const PALETTE = [
  ["black", [0, 0, 0]],
  ["dark grey", [64, 64, 64]],
  ["grey", [128, 128, 128]],
  ["light grey", [192, 192, 192]],
  ["white", [255, 255, 255]],
  ["red", [220, 40, 40]],
  ["orange", [230, 120, 30]],
  ["yellow", [230, 210, 30]],
  ["green", [50, 160, 70]],
  ["blue", [40, 100, 220]],
  ["purple", [140, 60, 180]],
  ["pink", [220, 80, 150]],
  ["brown", [130, 80, 40]],
  ["beige", [220, 200, 160]],
];
const DEAD_SET = new Set(DEAD_SLUGS);

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value);
}

/**
 * Select the top candidate only when the top-two margin is reliable.  The
 * boundary is intentionally inclusive: exactly 0.005 is kept, while values
 * below it are dropped.
 */
export function selectFacet(scores, margin = MARGIN_THRESHOLD) {
  if (!Array.isArray(scores) || scores.length === 0) return null;
  const ranked = scores
    .filter((entry) => entry && typeof entry.label === "string" && Number.isFinite(Number(entry.score)))
    .map((entry) => ({ label: entry.label, score: Number(entry.score) }))
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  const delta = ranked.length > 1 ? ranked[0].score - ranked[1].score : Number.POSITIVE_INFINITY;
  // A decimal boundary such as 0.105 - 0.1 can be represented a hair below
  // 0.005 in binary floating point; the epsilon preserves the documented
  // inclusive boundary without weakening the 0.004 gate.
  return delta + Number.EPSILON >= margin ? ranked[0].label : null;
}

/** A small numeric helper exported for pure tests and future tuning. */
export function marginGate(topScore, runnerUpScore, margin = MARGIN_THRESHOLD) {
  if (Array.isArray(topScore)) return selectFacet(topScore, runnerUpScore ?? margin);
  const top = asFiniteNumber(topScore);
  const runner = asFiniteNumber(runnerUpScore);
  return Number.isFinite(top) && Number.isFinite(runner) && top - runner + Number.EPSILON >= margin;
}

function removeArticle(value) {
  return value.replace(/^(?:an?|the)\s+/i, "");
}

function articleFor(value) {
  return /^[aeiou]/i.test(value.trim()) ? "an" : "a";
}

function rgbDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function nearestPalette(rgb) {
  let best = PALETTE[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of PALETTE) {
    const distance = rgbDistance(rgb, candidate[1]);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best[0];
}

function averagePixels(data, width, height, points) {
  if (points.length === 0) return [0, 0, 0];
  const sum = [0, 0, 0];
  for (const [x, y] of points) {
    const offset = (y * width + x) * 3;
    sum[0] += data[offset];
    sum[1] += data[offset + 1];
    sum[2] += data[offset + 2];
  }
  return sum.map((channel) => channel / points.length);
}

function cornerPixels(width, height, patchSize) {
  const points = [];
  const xRanges = [
    [0, Math.min(width, patchSize)],
    [Math.max(0, width - patchSize), width],
  ];
  const yRanges = [
    [0, Math.min(height, patchSize)],
    [Math.max(0, height - patchSize), height],
  ];
  for (const [xStart, xEnd] of xRanges) {
    for (const [yStart, yEnd] of yRanges) {
      for (let y = yStart; y < yEnd; y += 1) {
        for (let x = xStart; x < xEnd; x += 1) points.push([x, y]);
      }
    }
  }
  return points;
}

/**
 * Classify colour from a raw RGB buffer.  This intentionally walks the pixel
 * buffer rather than using sharp().stats(), whose statistics describe the
 * original input and ignore an upstream resize/extract pipeline.
 *
 * Accepted input forms are either `{ data, info: { width, height, channels } }`
 * (the shape returned by sharp) or `(data, width, height, finish)` for pure
 * callers.
 */
export function classifyColour(input, width, height, finish = null, options = {}) {
  let data;
  let channels = 3;
  if (input && typeof input === "object" && input.data && (input.info || input.width)) {
    ({ data } = input);
    width = input.info?.width ?? input.width;
    height = input.info?.height ?? input.height;
    channels = input.info?.channels ?? input.channels ?? channels;
    finish = width && typeof arguments[1] === "string" ? arguments[1] : finish;
    options = typeof arguments[2] === "object" ? arguments[2] : options;
  } else {
    data = input;
  }
  if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new TypeError("classifyColour needs raw RGB data plus width and height");
  }
  if (channels < 3) throw new TypeError("classifyColour needs at least three channels");

  // Normalize RGBA/raw inputs to RGB so callers can pass sharp output with an
  // alpha channel without changing the colour measurement.
  let rgbData = data;
  if (channels !== 3) {
    rgbData = Buffer.alloc(width * height * 3);
    for (let source = 0, target = 0; target < rgbData.length; source += channels, target += 3) {
      rgbData[target] = data[source];
      rgbData[target + 1] = data[source + 1];
      rgbData[target + 2] = data[source + 2];
    }
  }

  const patchSize = Math.max(1, Math.min(12, Math.floor(Math.min(width, height) / 4)));
  const backdropRgb = averagePixels(rgbData, width, height, cornerPixels(width, height, patchSize));
  const threshold = options.threshold ?? 60;
  const subject = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const rgb = [rgbData[offset], rgbData[offset + 1], rgbData[offset + 2]];
      if (rgbDistance(rgb, backdropRgb) > threshold) subject.push(rgb);
    }
  }
  const subjectRgb = averagePixels(
    Buffer.from(subject.flat()),
    subject.length,
    1,
    subject.map((_, index) => [index, 0]),
  );
  const coverage = subject.length / (width * height);
  const colour = finish === "transparent" || coverage < 0.3 ? "clear" : nearestPalette(subjectRgb);
  return {
    colour,
    background: nearestPalette(backdropRgb),
    coverage,
    subjectRgb,
    backgroundRgb: backdropRgb,
  };
}

/** Read and downscale a source image before handing pixels to classifyColour. */
export async function classifyImageColour(filePath, finish = null) {
  const result = await sharp(filePath)
    .resize({ width: 128, height: 128, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return classifyColour(result, finish);
}

/**
 * Build the mechanical sentence.  Every optional visual facet is omitted as a
 * complete clause, so no dropped prediction can leave doubled spaces/commas.
 */
export function sentenceFromFacets(displayName, facets) {
  const parts = [];
  if (facets.colour) parts.push(facets.colour);
  if (facets.material) parts.push(removeArticle(facets.material));
  if (facets.form) parts.push(removeArticle(facets.form));

  if (parts.length === 0) return `A ${displayName}, from the modular enclosure series.`;
  // If SigLIP gates both the material and form, retain the slug-grounded
  // product identity as the noun rather than emitting an adjective followed
  // by a dangling comma ("A brown, on …").
  if (!facets.form) parts.push(displayName);

  const clauses = [`${articleFor(parts[0])} ${parts.join(" ")}`];
  if (facets.view) clauses.push(removeArticle(facets.view));
  if (facets.background) clauses.push(`on ${articleFor(facets.background)} ${facets.background} background`);
  const sentence = clauses.join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/**
 * Apply the upload form's canonical tag rules.  Arrays are accepted as a
 * convenience for generated tags; each element still follows the same rules.
 */
export function normalizeTags(input) {
  const values = (Array.isArray(input) ? input : [input]).flatMap((rawValue) => String(rawValue ?? "").split(","));
  const tags = [];
  const seen = new Set();
  for (const rawValue of values) {
    let value = String(rawValue).trim();
    if (value.startsWith("#")) value = value.slice(1);
    value = value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "-");
    if (!value || /[/%?#]/u.test(value) || hasControlCharacter(value)) continue;
    const length = [...value].length;
    if (length < 1 || length > 32 || seen.has(value)) continue;
    seen.add(value);
    tags.push(value);
    if (tags.length === 10) break;
  }
  return tags;
}

function visualTag(value) {
  return removeArticle(value).replace(/\s+/gu, "-");
}

function generatedTags(parsed, facets) {
  const tags = [...tagsFromSlug(parsed.slug)];
  if (facets.form) tags.push(visualTag(facets.form));
  if (facets.material) tags.push(visualTag(facets.material));
  if (facets.view) tags.push(visualTag(facets.view));
  if (facets.finish) tags.push(visualTag(facets.finish));
  if (facets.colour) tags.push(visualTag(facets.colour));
  return normalizeTags(tags.join(","));
}

async function loadClassifier() {
  const home = process.env.HOME ?? os.homedir();
  env.cacheDir = process.env.HF_CACHE_DIR ?? path.join(home, ".cache", "zfb-img-gallery", "models");
  env.allowRemoteModels = process.env.ALLOW_REMOTE_MODELS !== "0";
  return pipeline("zero-shot-image-classification", MODEL_ID, { dtype: "q8" });
}

function facetValues(result, facet) {
  if (!Array.isArray(result)) return null;
  const selected = selectFacet(result);
  if (!selected) return null;
  return facet === "form" ? removeArticle(selected) : selected;
}

async function prepareModelImage(filePath) {
  const result = await sharp(filePath)
    .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new RawImage(new Uint8ClampedArray(result.data), result.info.width, result.info.height, result.info.channels);
}

async function classifyFacets(classifier, filePath) {
  const image = await prepareModelImage(filePath);
  const entries = await Promise.all(
    Object.entries(FACETS).map(async ([facet, labels]) => {
      const output = await classifier(image, labels);
      return [facet, facetValues(output, facet)];
    }),
  );
  return Object.fromEntries(entries);
}

function parseArgs(argv) {
  const args = { limit: undefined, only: undefined, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit" || arg === "--only" || arg === "--out") {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--limit") {
        args.limit = Number(value);
        if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer");
      } else if (arg === "--only") args.only = value;
      else args.out = path.resolve(REPO_ROOT, value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

async function writeAtomic(destination, object) {
  const temporary = `${destination}.part`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(object, null, 2)}\n`, "utf8");
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function assertManifest(photos, slugs) {
  const errors = [];
  const slugSet = new Set(slugs);
  const facetKeys = ["form", "material", "view", "finish", "colour", "background"];
  if (slugs.some((slug) => DEAD_SET.has(slug))) errors.push("slugs.txt contains a dead slug");
  for (const photo of photos) {
    if (!slugSet.has(photo.slug)) errors.push(`${photo.slug}: not present in slugs.txt`);
    if (DEAD_SET.has(photo.slug)) errors.push(`${photo.slug}: dead slug in manifest`);
    for (const localPath of [photo.localPath, photo.thumbLocalPath]) {
      const absolute = path.resolve(REPO_ROOT, localPath);
      try {
        const details = requireStat(absolute);
        if (details.size <= 0) errors.push(`${photo.slug}: empty ${localPath}`);
      } catch {
        errors.push(`${photo.slug}: missing ${localPath}`);
      }
    }
    if (!Number.isInteger(photo.bytes) || photo.bytes <= 0 || photo.bytes >= MAX_BYTES) {
      errors.push(`${photo.slug}: original must be a non-empty file under 4 MB`);
    }
    if (!photo.description || /[\r\n]/u.test(photo.description)) errors.push(`${photo.slug}: description must be one non-empty line`);
    if (!Array.isArray(photo.tags) || photo.tags.length < 1 || photo.tags.length > 10) errors.push(`${photo.slug}: tags must contain 1-10 values`);
    if (!photo.facets || facetKeys.some((key) => !(key in photo.facets) || (photo.facets[key] !== null && typeof photo.facets[key] !== "string"))) {
      errors.push(`${photo.slug}: facets must expose string-or-null values for every facet`);
    }
  }
  const titleOwners = new Map();
  for (const photo of photos) {
    if (titleOwners.has(photo.title)) errors.push(`duplicate title ${JSON.stringify(photo.title)} (${titleOwners.get(photo.title)}, ${photo.slug})`);
    else titleOwners.set(photo.title, photo.slug);
  }
  if (errors.length > 0) throw new Error(`Manifest assertions failed:\n- ${errors.join("\n- ")}`);
}

async function readInputSlugs({ limit, only }) {
  const contents = await readFile(SLUG_FILE, "utf8");
  const slugs = contents.split(/\r?\n/).filter(Boolean);
  if (new Set(slugs).size !== slugs.length) throw new Error("slugs.txt contains duplicate slugs");
  const sorted = [...slugs].sort();
  if (slugs.some((slug, index) => slug !== sorted[index])) throw new Error("slugs.txt must be sorted ascending");
  if (slugs.some((slug) => DEAD_SET.has(slug))) throw new Error("slugs.txt contains a dead slug");
  let selected = slugs;
  if (only !== undefined) {
    if (!slugs.includes(only)) throw new Error(`--only slug is not present in slugs.txt: ${only}`);
    selected = [only];
  } else if (limit !== undefined) selected = slugs.slice(0, limit);
  return { allSlugs: slugs, selectedSlugs: selected };
}

function manifestFacets(visual, colour) {
  return {
    form: visual.form ?? null,
    material: visual.material ?? null,
    view: visual.view ?? null,
    finish: visual.finish ?? null,
    colour: colour.colour ?? null,
    background: colour.background ?? null,
  };
}

async function describePhoto(slug, classifier) {
  const parsed = parseSlug(slug);
  const fullPath = path.join(PHOTO_DIR, "2000w", `${slug}.webp`);
  const thumbPath = path.join(PHOTO_DIR, "600w", `${slug}.webp`);
  const [fullDetails, thumbDetails] = await Promise.all([stat(fullPath), stat(thumbPath)]);
  if (fullDetails.size <= 0 || thumbDetails.size <= 0) throw new Error(`${slug}: mirror files must be non-empty`);
  const visual = await classifyFacets(classifier, fullPath);
  const colour = await classifyImageColour(fullPath, visual.finish);
  const facets = manifestFacets(visual, colour);
  const description = sentenceFromFacets(parsed.displayName, facets);
  const review = parsed.materialHint && visual.material && parsed.materialHint !== visual.material
    ? {
        slug,
        reason: "material-disagreement",
        slugHint: parsed.materialHint,
        siglip: visual.material,
      }
    : null;
  return {
    photo: {
      slug,
      localPath: `data/photos/2000w/${slug}.webp`,
      thumbLocalPath: `data/photos/600w/${slug}.webp`,
      bytes: fullDetails.size,
      title: titleFromSlug(slug),
      description,
      tags: generatedTags(parsed, facets),
      facets,
    },
    review,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { allSlugs, selectedSlugs } = await readInputSlugs(args);
  if (selectedSlugs.length === 0) throw new Error("No slugs selected");

  console.log(`Loading ${MODEL_ID} (${selectedSlugs.length} photo${selectedSlugs.length === 1 ? "" : "s"})…`);
  const classifier = await loadClassifier();
  const photos = [];
  const review = [];
  for (const slug of selectedSlugs) {
    const result = await describePhoto(slug, classifier);
    photos.push(result.photo);
    if (result.review) review.push(result.review);
    console.log(`Described ${photos.length}/${selectedSlugs.length}: ${slug}`);
  }

  assertManifest(photos, allSlugs);
  const manifest = { generatedAt: new Date().toISOString(), model: MODEL_ID, photos, review };
  await writeAtomic(args.out, manifest);
  console.log(`Wrote ${path.relative(REPO_ROOT, args.out)}: ${photos.length} photos; material disagreements: ${review.length}`);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(`describe-photos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
