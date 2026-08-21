import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import {
  DEFAULT_MANIFEST,
  DEFAULT_PHOTOS_DIR,
  REPO_ROOT,
  normalizeSeedTags,
  readManifest,
  readWranglerValue,
} from "./lib/seed-helpers.mjs";

const execFile = promisify(execFileCallback);
const DEFAULT_BASE_URL = "http://localhost:8788";
const DEFAULT_PERSIST_TO = ".wrangler/state";
const DEFAULT_EMAIL = "takazudo@example.com";
const SEED_USERNAME = "takazudo";
const SUBMIT_TIMEOUT = 120_000;

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/seed-upload.mjs [--base-url <url>] [--photos-dir <dir>] [--manifest <path>] [--d1 <name>] [--persist-to <dir>] [--remote] [--limit <n>] [--headed]`,
  );
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    photosDir: DEFAULT_PHOTOS_DIR,
    manifest: DEFAULT_MANIFEST,
    d1: undefined,
    persistTo: DEFAULT_PERSIST_TO,
    remote: false,
    limit: undefined,
    headed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      args.remote = true;
      continue;
    }
    if (arg === "--headed") {
      args.headed = true;
      continue;
    }
    if (["--base-url", "--photos-dir", "--manifest", "--d1", "--persist-to", "--limit"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usageError(`${arg} needs a value`);
      index += 1;
      if (arg === "--base-url") args.baseUrl = value;
      else if (arg === "--photos-dir") args.photosDir = value;
      else if (arg === "--manifest") args.manifest = value;
      else if (arg === "--d1") args.d1 = value;
      else if (arg === "--persist-to") args.persistTo = value;
      else {
        args.limit = Number(value);
        if (!Number.isInteger(args.limit) || args.limit < 1) usageError("--limit must be a positive integer");
      }
      continue;
    }
    usageError(`Unknown option: ${arg}`);
  }

  try {
    args.baseUrl = new URL(args.baseUrl).toString();
  } catch {
    usageError(`--base-url is not a valid URL: ${args.baseUrl}`);
  }
  args.photosDir = resolveFromRepo(args.photosDir);
  args.manifest = resolveFromRepo(args.manifest);
  args.persistTo = resolveFromRepo(args.persistTo);
  return args;
}

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function commandArgs(args) {
  return args.remote ? ["--remote"] : ["--local", "--persist-to", args.persistTo];
}

async function runWrangler(wranglerArgs) {
  try {
    const result = await execFile("pnpm", ["exec", "wrangler", ...wranglerArgs], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    const stderr = error?.stderr?.toString?.() ?? "";
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`Wrangler command failed (${wranglerArgs.join(" ")}):${detail ? `\n${detail}` : ""}`, {
      cause: error,
    });
  }
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // A future Wrangler version may print a warning before --json output.
    // Recover only a complete JSON array/object; never attempt to evaluate text.
    const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((index) => index >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // Try the next possible JSON start.
      }
    }
    throw new Error(`${label} did not return JSON:\n${trimmed}`);
  }
}

async function readD1(args, sql) {
  const output = await runWrangler([
    "d1",
    "execute",
    args.d1,
    ...commandArgs(args),
    "--json",
    "--command",
    sql,
  ]);
  const payload = parseJsonOutput(output, "D1 query");
  const result = Array.isArray(payload) ? payload[0] : payload;
  if (!result || result.success !== true) {
    throw new Error(`D1 query failed${result?.error ? `: ${result.error}` : ""}`);
  }
  return Array.isArray(result.results) ? result.results : [];
}

async function loginAndCheck(page, email, password) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  // Registration creates a session and redirects to `/`; a subsequent
  // `/login` visit therefore may not render login fields at all.
  if ((await page.locator('input[name="email"]').count()) === 0) {
    await page.goto("/upload", { waitUntil: "domcontentloaded" });
    return (await page.locator('input[name="photo"]').count()) > 0;
  }
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('form[action="/login"] button[type="submit"]');
  await page.goto("/upload", { waitUntil: "domcontentloaded" });
  return (await page.locator('input[name="photo"]').count()) > 0;
}

async function ensureLoggedIn(page, email, password) {
  if (await loginAndCheck(page, email, password)) return;

  await page.goto("/register", { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="username"]', "Takazudo");
  await page.fill('input[name="password"]', password);
  // A duplicate registration deliberately re-renders /register with 409;
  // clicking need not be paired with a URL assertion here.
  await page.click('form[action="/register"] button[type="submit"]');
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (!(await loginAndCheck(page, email, password))) {
    throw new Error("Could not authenticate the seed account at /upload after login and registration attempts");
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function secondsSince(start) {
  return ((performance.now() - start) / 1000).toFixed(1);
}

async function uploadOne(page, photo) {
  await page.goto("/upload", { waitUntil: "domcontentloaded" });
  await page.setInputFiles('input[name="photo"]', photo.fullPath);
  await page.fill('input[name="title"]', photo.title);
  await page.fill('textarea[name="description"]', photo.description);
  await page.fill('input[name="tags"]', normalizeSeedTags(photo.tags).join(", "));
  await Promise.all([
    page.waitForURL(/\/photos\/\d+(?:[/?#]|$)/u, { timeout: SUBMIT_TIMEOUT }),
    page.click('form[action="/upload"] button[type="submit"]'),
  ]);
}

async function main(argv = process.argv.slice(2)) {
  // Keep this check before manifest work and, critically, before browser launch.
  const password = process.env.SEED_TAKAZUDO_PASSWORD;
  if (!password) throw new Error("SEED_TAKAZUDO_PASSWORD is required; export it in the environment before seeding");

  const args = parseArgs(argv);
  if (!args.d1) args.d1 = await readWranglerValue("database_name");
  const email = process.env.SEED_TAKAZUDO_EMAIL || DEFAULT_EMAIL;
  const manifest = await readManifest(args.manifest, args.photosDir, { checkFiles: false });
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ baseURL: args.baseUrl });
  context.setDefaultTimeout(60_000);
  context.setDefaultNavigationTimeout(60_000);
  const page = await context.newPage();
  const failures = [];
  let uploaded = 0;
  let skipped = 0;

  try {
    await ensureLoggedIn(page, email, password);

    const rows = await readD1(
      args,
      `SELECT title FROM photos WHERE user_id = (SELECT id FROM users WHERE username = '${SEED_USERNAME}')`,
    );
    const uploadedTitles = new Set(rows.map((row) => row?.title).filter((title) => typeof title === "string"));

    for (let index = 0; index < manifest.length; index += 1) {
      const photo = manifest[index];
      if (uploadedTitles.has(photo.title)) {
        skipped += 1;
        console.log(`[${index + 1}/${manifest.length}] ${photo.slug} — skipped (already uploaded)`);
        continue;
      }
      if (args.limit !== undefined && uploaded >= args.limit) {
        console.log(`Limit ${args.limit} reached; leaving remaining manifest entries for a later run.`);
        break;
      }
      const started = performance.now();
      if (photo.tooLarge) {
        skipped += 1;
        console.log(`[${index + 1}/${manifest.length}] ${photo.slug} — skipped (original is at least 4 MiB)`);
        continue;
      }
      if (photo.fileError) {
        failures.push({ slug: photo.slug, error: photo.fileError });
        console.log(`[${index + 1}/${manifest.length}] ${photo.slug} — failed (${photo.fileError})`);
        continue;
      }
      try {
        await uploadOne(page, photo);
        uploadedTitles.add(photo.title);
        uploaded += 1;
        console.log(`[${index + 1}/${manifest.length}] ${photo.slug} — ok (${secondsSince(started)}s)`);
      } catch (error) {
        const message = errorMessage(error);
        failures.push({ slug: photo.slug, error: message });
        console.log(`[${index + 1}/${manifest.length}] ${photo.slug} — failed (${message})`);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`Seed summary: uploaded ${uploaded}, skipped ${skipped}, failed ${failures.length}`);
  if (failures.length > 0) {
    console.log("Failed slugs:");
    for (const failure of failures) console.log(failure.slug);
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`seed-upload: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

export { main, parseArgs };
