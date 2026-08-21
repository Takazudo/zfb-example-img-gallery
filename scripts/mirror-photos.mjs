import { open, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEAD_SLUGS } from "./lib/slug-taxonomy.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PHOTO_DIR = path.join(REPO_ROOT, "data", "photos");
const SLUG_FILE = path.join(PHOTO_DIR, "slugs.txt");
const CDN_ORIGIN = "https://imgs.takazudomodular.com";
const SIZES = ["2000w", "600w"];
const USER_AGENT = "zfb-img-gallery-photo-mirror/1.0";
const DEFAULT_CONCURRENCY = 6;
const RETRY_DELAYS_MS = [500, 1000, 2000];
const DEAD_SET = new Set(DEAD_SLUGS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usageError(message) {
  throw new Error(`${message}\nUsage: node scripts/mirror-photos.mjs [--discover] [--concurrency 6] [--limit N] [--only <slug>] [--force]`);
}

function parseArgs(argv) {
  const args = {
    concurrency: DEFAULT_CONCURRENCY,
    limit: undefined,
    only: undefined,
    force: false,
    discover: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--discover") args.discover = true;
    else if (arg === "--concurrency" || arg === "--limit" || arg === "--only") {
      const value = argv[++i];
      if (!value) usageError(`${arg} needs a value`);
      if (arg === "--concurrency") {
        args.concurrency = Number(value);
        if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32) {
          usageError("--concurrency must be an integer from 1 to 32");
        }
      } else if (arg === "--limit") {
        args.limit = Number(value);
        if (!Number.isInteger(args.limit) || args.limit < 1) usageError("--limit must be a positive integer");
      } else {
        args.only = value;
      }
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function requestOptions(method = "GET") {
  return { method, headers: { "user-agent": USER_AGENT } };
}

function imageUrl(slug, size) {
  return `${CDN_ORIGIN}/images/p/${encodeURIComponent(slug)}/${size}.webp`;
}

async function fetchWithRetries(url, options, { label = url } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status === 404) return response;
      if (response.status >= 500 && response.status <= 599 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${detail}`);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function runWorkers(items, concurrency, worker) {
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, run));
}

function parseSitemapLocs(xml) {
  const urls = new Set();
  for (const match of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    const raw = match[1].trim();
    try {
      const url = new URL(raw);
      // The Japanese/English locale pages duplicate the canonical URL set.
      const pathname = url.pathname.replace(/^\/en(?=\/|$)/, "") || "/";
      url.pathname = pathname;
      url.search = "";
      url.hash = "";
      urls.add(url.toString());
    } catch {
      // Ignore malformed sitemap entries; a valid URL is required for fetching.
    }
  }
  return [...urls];
}

async function discoverSlugs({ concurrency, force }) {
  if (!force) {
    try {
      await stat(SLUG_FILE);
      throw new Error(`${path.relative(REPO_ROOT, SLUG_FILE)} already exists; pass --force to overwrite it`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const sitemapResponse = await fetchWithRetries("https://takazudomodular.com/sitemap.xml", requestOptions(), {
    label: "sitemap",
  });
  if (!sitemapResponse.ok) throw new Error(`sitemap returned HTTP ${sitemapResponse.status}`);
  const sitemap = await sitemapResponse.text();
  const pageUrls = parseSitemapLocs(sitemap);
  const candidates = new Set();
  let pageFailures = 0;
  await runWorkers(pageUrls, concurrency, async (pageUrl) => {
    try {
      const response = await fetchWithRetries(pageUrl, requestOptions(), { label: pageUrl });
      if (!response.ok) {
        pageFailures += 1;
        return;
      }
      const html = await response.text();
      for (const match of html.matchAll(/images\/p\/([a-z0-9][a-z0-9_-]*)\//g)) {
        const slug = match[1];
        if (!slug.includes("__og") && !slug.includes("__ogonly") && !DEAD_SET.has(slug)) {
          candidates.add(slug);
        }
      }
    } catch {
      pageFailures += 1;
    }
  });

  const candidateList = [...candidates].sort();
  const usable = [];
  await runWorkers(candidateList, concurrency, async (slug) => {
    const responses = await Promise.all(
      SIZES.map((size) => fetchWithRetries(imageUrl(slug, size), requestOptions("HEAD"), { label: `${slug}/${size}` })),
    );
    if (responses.every((response) => response.status === 200)) usable.push(slug);
  });
  usable.sort();
  await writeAtomic(SLUG_FILE, `${usable.join("\n")}\n`);

  console.log(`Discovery: ${pageUrls.length} pages, ${candidateList.length} candidates, ${usable.length} usable${pageFailures ? `, ${pageFailures} page failures` : ""}`);
  if (usable.length < 293) {
    console.warn("Discovery yielded fewer than the 293-photo target; review the crawl scope before using this list.");
  }
}

async function writeAtomic(destination, contents) {
  const temporary = `${destination}.part`;
  await writeFile(temporary, contents, "utf8");
  const handle = await open(temporary, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
}

function readSlugs(contents) {
  const lines = contents.split(/\r?\n/).filter(Boolean);
  const invalid = lines.filter((slug) => DEAD_SET.has(slug));
  if (invalid.length > 0) throw new Error(`slugs.txt contains dead slug(s): ${invalid.join(", ")}`);
  if (new Set(lines).size !== lines.length) throw new Error("slugs.txt contains duplicate slugs");
  const sorted = [...lines].sort();
  if (sorted.some((slug, index) => slug !== lines[index])) throw new Error("slugs.txt must be sorted ascending");
  return lines;
}

async function remoteLength(slug, size) {
  const response = await fetchWithRetries(imageUrl(slug, size), requestOptions("HEAD"), { label: `${slug}/${size}` });
  if (response.status === 404) return { status: 404, length: null };
  if (!response.ok) throw new Error(`${slug}/${size}: HEAD returned HTTP ${response.status}`);
  const header = response.headers.get("content-length");
  const length = header && /^\d+$/.test(header) ? Number(header) : null;
  return { status: response.status, length };
}

async function downloadResponse(url, destination, temporary, expectedLength, label) {
  for (let attempt = 0; ; attempt += 1) {
    await rm(temporary, { force: true });
    let handle;
    try {
      const response = await fetch(url, requestOptions());
      if (response.status === 404) return { status: "failed", reason: "404" };
      if (response.status >= 500 && response.status <= 599) {
        if (attempt >= RETRY_DELAYS_MS.length) throw new Error(`${label}: GET returned HTTP ${response.status}`);
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!response.ok || !response.body) {
        const error = new Error(`${label}: GET returned HTTP ${response.status}`);
        error.retryable = response.status >= 500 && response.status <= 599;
        throw error;
      }

      let bytes = 0;
      handle = await open(temporary, "w");
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        await handle.write(buffer);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (expectedLength !== null && bytes !== expectedLength) {
        throw new Error(`${label}: expected ${expectedLength} bytes, received ${bytes}`);
      }
      await rename(temporary, destination);
      return { status: "downloaded" };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true });
      if (error?.retryable === false || attempt >= RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function downloadOne(slug, size, force) {
  const tier = path.join(PHOTO_DIR, size);
  const destination = path.join(tier, `${slug}.webp`);
  const temporary = `${destination}.part`;
  await mkdir(tier, { recursive: true });

  const remote = await remoteLength(slug, size);
  if (remote.status === 404) return { status: "failed", reason: "404" };

  if (!force && remote.length !== null) {
    try {
      const existing = await stat(destination);
      if (existing.size > 0 && existing.size === remote.length) return { status: "skipped" };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  return downloadResponse(imageUrl(slug, size), destination, temporary, remote.length, `${slug}/${size}`);
}

async function mirrorSlugs(slugs, { concurrency, limit, only, force }) {
  if (only !== undefined) {
    if (DEAD_SET.has(only)) throw new Error(`Refusing dead slug: ${only}`);
    if (!slugs.includes(only)) throw new Error(`--only slug is not present in ${path.relative(REPO_ROOT, SLUG_FILE)}: ${only}`);
    slugs = [only];
  } else if (limit !== undefined) {
    slugs = slugs.slice(0, limit);
  }

  const summary = { downloaded: 0, skipped: 0, failed: 0 };
  const failedSlugs = new Set();
  await runWorkers(slugs, concurrency, async (slug) => {
    const results = [];
    for (const size of SIZES) {
      try {
        results.push(await downloadOne(slug, size, force));
      } catch (error) {
        results.push({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const result of results) summary[result.status] += 1;
    if (results.some((result) => result.status === "failed")) failedSlugs.add(slug);
  });

  console.log(`Mirror summary: downloaded ${summary.downloaded}, skipped ${summary.skipped}, failed ${summary.failed}`);
  if (failedSlugs.size > 0) console.log(`Failed slugs: ${[...failedSlugs].sort().join(", ")}`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.discover) {
    await discoverSlugs(args);
    return;
  }
  const contents = await readFile(SLUG_FILE, "utf8");
  const slugs = readSlugs(contents);
  await mirrorSlugs(slugs, args);
}

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error(`mirror-photos: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
