/*
 * DEMO-SEED STEP — this is a demo-seed step, not a product feature. Genuine user uploads keep
 * photos.thumb_key = NULL and the application falls back to photos.r2_key.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  DEFAULT_MANIFEST,
  DEFAULT_PHOTOS_DIR,
  REPO_ROOT,
  deriveThumbKey,
  readManifest,
  readWranglerValue,
  sqlLiteral,
} from "./lib/seed-helpers.mjs";

const execFile = promisify(execFileCallback);
const DEFAULT_PERSIST_TO = ".wrangler/state";
const DEFAULT_CONCURRENCY = 4;
const SEED_USERNAME = "takazudo";

function usageError(message) {
  throw new Error(
    `${message}\nUsage: node scripts/backfill-thumbs.mjs [--photos-dir <dir>] [--manifest <path>] [--d1 <name>] [--bucket <name>] [--persist-to <dir>] [--remote] [--force]`,
  );
}

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function parseArgs(argv) {
  const args = {
    photosDir: DEFAULT_PHOTOS_DIR,
    manifest: DEFAULT_MANIFEST,
    d1: undefined,
    bucket: undefined,
    persistTo: DEFAULT_PERSIST_TO,
    remote: false,
    force: false,
    concurrency: DEFAULT_CONCURRENCY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      args.remote = true;
      continue;
    }
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (["--photos-dir", "--manifest", "--d1", "--bucket", "--persist-to", "--concurrency"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usageError(`${arg} needs a value`);
      index += 1;
      if (arg === "--photos-dir") args.photosDir = value;
      else if (arg === "--manifest") args.manifest = value;
      else if (arg === "--d1") args.d1 = value;
      else if (arg === "--bucket") args.bucket = value;
      else if (arg === "--persist-to") args.persistTo = value;
      else {
        args.concurrency = Number(value);
        if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 16) {
          usageError("--concurrency must be an integer from 1 to 16");
        }
      }
      continue;
    }
    usageError(`Unknown option: ${arg}`);
  }
  args.photosDir = resolveFromRepo(args.photosDir);
  args.manifest = resolveFromRepo(args.manifest);
  args.persistTo = resolveFromRepo(args.persistTo);
  return args;
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

async function writeD1File(args, sqlFile) {
  await runWrangler(["d1", "execute", args.d1, ...commandArgs(args), "--file", sqlFile]);
}

function createRemoteClient() {
  const accountId = process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error(
      "Remote R2 backfill requires R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_ACCOUNT_ID (or R2_ENDPOINT) in the environment",
    );
  }
  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function putLocal(args, bucket, job) {
  await runWrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${job.thumbKey}`,
    "--file",
    job.thumbPath,
    "--content-type",
    "image/webp",
    "--local",
    "--persist-to",
    args.persistTo,
  ]);
}

async function putRemote(client, bucket, job) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: job.thumbKey,
      Body: createReadStream(job.thumbPath),
      ContentType: "image/webp",
    }),
  );
}

async function runBounded(jobs, concurrency, worker) {
  let cursor = 0;
  const results = [];
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      results[index] = await worker(jobs[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, consume));
  return results;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function secondsSince(start) {
  return ((performance.now() - start) / 1000).toFixed(1);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.d1) args.d1 = await readWranglerValue("database_name");
  if (!args.bucket) args.bucket = await readWranglerValue("bucket_name");

  console.log("DEMO-SEED STEP: this is a demo-seed step, not a product feature; backfilling thumbnails.");
  console.log("Genuine user uploads keep thumb_key NULL and fall back to r2_key.");

  const manifest = await readManifest(args.manifest, args.photosDir, { checkFiles: false });
  const manifestByTitle = new Map(manifest.map((photo) => [photo.title, photo]));
  const rows = await readD1(
    args,
    `SELECT id, title, r2_key, thumb_key FROM photos WHERE user_id = (SELECT id FROM users WHERE username = '${SEED_USERNAME}')`,
  );
  const rowTitles = new Set();
  const jobs = [];
  const problems = [];
  let skipped = 0;

  for (const row of rows) {
    const title = typeof row?.title === "string" ? row.title : "";
    rowTitles.add(title);
    const photo = manifestByTitle.get(title);
    if (!photo) {
      // The seed account may also contain genuine user uploads. They are not
      // part of the demo manifest and intentionally keep thumb_key = NULL.
      console.log(`skip row ${JSON.stringify(title)} — not a seed manifest row`);
      skipped += 1;
      continue;
    }
    if (row.thumb_key !== null && row.thumb_key !== undefined && !args.force) {
      skipped += 1;
      console.log(`${photo.slug} — skipped (thumb_key already set)`);
      continue;
    }
    if (photo.fileError) {
      problems.push(`${photo.slug}: ${photo.fileError}`);
      console.log(`${photo.slug} — skipped (${photo.fileError})`);
      skipped += 1;
      continue;
    }
    let thumbKey;
    try {
      thumbKey = deriveThumbKey(row.r2_key);
      // Both values are later interpolated into SQL and are guarded here too,
      // before any object is uploaded.
      sqlLiteral(row.r2_key, `${photo.slug} r2_key`);
      sqlLiteral(thumbKey, `${photo.slug} thumb_key`);
    } catch (error) {
      const message = errorMessage(error);
      problems.push(`${photo.slug}: ${message}`);
      console.log(`${photo.slug} — skipped (${message})`);
      skipped += 1;
      continue;
    }
    jobs.push({ slug: photo.slug, r2Key: row.r2_key, thumbKey, thumbPath: photo.thumbPath });
  }

  for (const photo of manifest) {
    if (!rowTitles.has(photo.title)) {
      problems.push(`${photo.slug}: manifest entry has no seeded database row`);
      console.log(`${photo.slug} — skipped (no seeded database row)`);
      skipped += 1;
    }
  }

  // An already-complete remote run should remain idempotent even when the
  // operator no longer has R2 write credentials in the environment.
  const client = args.remote && jobs.length > 0 ? createRemoteClient() : null;
  const successful = [];
  try {
    await runBounded(jobs, args.concurrency, async (job, index) => {
      const started = performance.now();
      try {
        if (client) await putRemote(client, args.bucket, job);
        else await putLocal(args, args.bucket, job);
        successful.push(job);
        console.log(`[${index + 1}/${jobs.length}] ${job.slug} — put (${secondsSince(started)}s)`);
        return true;
      } catch (error) {
        const message = errorMessage(error);
        problems.push(`${job.slug}: ${message}`);
        console.log(`[${index + 1}/${jobs.length}] ${job.slug} — failed (${message})`);
        return false;
      }
    });
  } finally {
    client?.destroy();
  }

  let updated = 0;
  let sqlFile;
  let temporaryDirectory;
  try {
    if (successful.length > 0) {
      const values = successful
        .map((job) => `       (${sqlLiteral(job.r2Key, `${job.slug} r2_key`)}, ${sqlLiteral(job.thumbKey, `${job.slug} thumb_key`)})`)
        .join(",\n");
      const sql = `WITH t(r2_key, thumb_key) AS (\n  VALUES\n${values}\n)\nUPDATE photos\n   SET thumb_key = t.thumb_key\n  FROM t\n WHERE photos.r2_key = t.r2_key;\n`;
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "img-gallery-thumb-backfill-"));
      sqlFile = path.join(temporaryDirectory, "thumb-backfill.sql");
      await writeFile(sqlFile, sql, "utf8");
      await writeD1File(args, sqlFile);
      updated = successful.length;
    }
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`Backfill summary: put ${successful.length}, updated ${updated}, skipped ${skipped}, failed ${problems.length}`);
  if (problems.length > 0) {
    console.log("Problems:");
    for (const problem of problems) console.log(problem);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`backfill-thumbs: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

export { main, parseArgs };
