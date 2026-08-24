/*
 * OPERATOR MAINTENANCE STEP — this script fills nullable legacy
 * photos.blurhash values. It reads originals only; it never writes or deletes
 * an R2 object. Remote mode is deliberately opt-in and requires both resource
 * names on the command line.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { decode as decodeBlurhash } from "blurhash";

import { REPO_ROOT, readWranglerValue } from "./lib/seed-helpers.mjs";
import {
  DEFAULT_MAX_DOWNLOAD_BYTES,
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_MAX_SHARP_PIXELS,
  MIN_BLURHASH_AXIS,
  blurhashFromOriginal,
} from "./lib/blurhash-backfill.mjs";

const execFile = promisify(execFileCallback);

export const DEFAULT_PERSIST_TO = ".wrangler/state";
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 10_000;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_SQL_BATCH_SIZE = 50;
export const MAX_SQL_BATCH_SIZE = 100;
export const DEFAULT_ROW_TIMEOUT_MS = 30_000;
export const MAX_ROW_TIMEOUT_MS = 120_000;
export const MAX_PAGE_SIZE = 100;
export const MAX_OBJECT_BYTES = DEFAULT_MAX_OBJECT_BYTES;
export const MAX_DOWNLOAD_BYTES = DEFAULT_MAX_DOWNLOAD_BYTES;
export const MAX_SHARP_PIXELS = DEFAULT_MAX_SHARP_PIXELS;

const BLURHASH_LENGTH = 36;
// BlurHash's size flag is (componentsX - 1) * 9 + (componentsY - 1), encoded
// in base83. Fixed 4x4 therefore has value 30, whose base83 character is U.
const BLURHASH_SIZE_FLAG = "U";
const BLURHASH_BASE83 = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~");
const SAFE_BUCKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function usage(message) {
  throw new Error(
    `${message}\nUsage: node scripts/backfill-blurhash.mjs [--d1 <name>] [--bucket <name>] [--persist-to <dir>] [--remote] [--dry-run] [--force] [--limit <n>] [--concurrency <n>] [--sql-batch-size <n>] [--max-object-bytes <n>] [--max-download-bytes <n>] [--max-pixels <n>] [--row-timeout-ms <n>]`,
  );
}

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function parseBoundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(value)) usage(`${label} must be an integer from ${minimum} to ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    usage(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/** Parse the operator-facing flags without reading resources or making calls. */
export function parseArgs(argv = []) {
  const args = {
    d1: undefined,
    bucket: undefined,
    persistTo: resolveFromRepo(DEFAULT_PERSIST_TO),
    remote: false,
    dryRun: false,
    force: false,
    limit: DEFAULT_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    sqlBatchSize: DEFAULT_SQL_BATCH_SIZE,
    maxObjectBytes: MAX_OBJECT_BYTES,
    maxDownloadBytes: MAX_DOWNLOAD_BYTES,
    maxPixels: MAX_SHARP_PIXELS,
    rowTimeoutMs: DEFAULT_ROW_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      args.remote = true;
      continue;
    }
    if (arg === "--local") {
      args.remote = false;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    const valueFlags = new Map([
      ["--d1", ["d1", null, null]],
      ["--bucket", ["bucket", null, null]],
      ["--persist-to", ["persistTo", null, null]],
      ["--limit", ["limit", 1, MAX_LIMIT]],
      ["--concurrency", ["concurrency", 1, MAX_CONCURRENCY]],
      ["--sql-batch-size", ["sqlBatchSize", 1, MAX_SQL_BATCH_SIZE]],
      ["--max-object-bytes", ["maxObjectBytes", 1, MAX_OBJECT_BYTES]],
      ["--max-download-bytes", ["maxDownloadBytes", 1, MAX_DOWNLOAD_BYTES]],
      ["--max-pixels", ["maxPixels", 1, MAX_SHARP_PIXELS]],
      ["--row-timeout-ms", ["rowTimeoutMs", 100, MAX_ROW_TIMEOUT_MS]],
    ]);
    const descriptor = valueFlags.get(arg);
    if (descriptor) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage(`${arg} needs a value`);
      index += 1;
      const [field, minimum, maximum] = descriptor;
      if (minimum === null) {
        args[field] = value;
      } else {
        args[field] = parseBoundedInteger(value, arg, minimum, maximum);
      }
      continue;
    }
    usage(`Unknown option: ${arg}`);
  }

  if (args.maxObjectBytes > args.maxDownloadBytes) {
    usage("--max-object-bytes cannot exceed --max-download-bytes");
  }
  if (args.remote && (!args.d1 || !args.bucket)) {
    usage("--remote requires explicit --d1 <database> and --bucket <bucket>");
  }
  if (args.d1 !== undefined && !/^[A-Za-z0-9._-]+$/u.test(args.d1)) {
    usage("--d1 must be a simple database name");
  }
  if (args.bucket !== undefined && !SAFE_BUCKET_NAME.test(args.bucket)) {
    usage("--bucket must be a simple bucket name");
  }
  args.persistTo = resolveFromRepo(args.persistTo);
  return args;
}

function commandMode(args) {
  return args.remote ? ["--remote"] : ["--local", "--persist-to", args.persistTo];
}

async function runWranglerText(wranglerArgs) {
  try {
    const result = await execFile("pnpm", ["exec", "wrangler", ...wranglerArgs], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return result.stdout;
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    const detail = stderr.replace(/[\r\n]+$/u, "");
    throw new Error(`Wrangler command failed (${wranglerArgs.join(" ")})${detail ? `: ${detail}` : ""}`, {
      cause: error,
    });
  }
}

async function runWranglerBytes(wranglerArgs, maxBytes, signal) {
  try {
    const result = await execFile("pnpm", ["exec", "wrangler", ...wranglerArgs], {
      cwd: REPO_ROOT,
      // execFile terminates the child if stdout exceeds this byte budget.
      maxBuffer: maxBytes + 1,
      encoding: "buffer",
      signal,
    });
    const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    if (output.byteLength > maxBytes) throw new Error("R2 download exceeds byte limit");
    return new Uint8Array(output).slice();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    if (error instanceof Error && error.message === "R2 download exceeds byte limit") throw error;
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/iu.test(error?.message ?? "")) {
      throw new Error("R2 download exceeds byte limit", { cause: error });
    }
    const stderr = error?.stderr?.toString?.() ?? "";
    const detail = stderr.replace(/[\r\n]+$/u, "");
    throw new Error(`R2 object read failed${detail ? `: ${detail}` : ""}`, { cause: error });
  }
}

function parseJsonOutput(output, label) {
  const trimmed = String(output).trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const starts = [trimmed.indexOf("["), trimmed.indexOf("{")]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    for (const start of starts) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // Try the next possible JSON start.
      }
    }
    throw new Error(`${label} did not return JSON`);
  }
}

function d1Result(payload, label) {
  const candidates = Array.isArray(payload) ? payload : [payload];
  const result = candidates.find((candidate) => candidate && typeof candidate === "object");
  if (!result || result.success !== true) {
    throw new Error(`${label} failed`);
  }
  return result;
}

function normaliseRows(payload) {
  const result = d1Result(payload, "D1 query");
  return Array.isArray(result.results) ? result.results : [];
}

function mutationChanges(payload, fallback) {
  const candidates = Array.isArray(payload) ? payload : [payload];
  let changes = 0;
  let sawChanges = false;
  for (const candidate of candidates) {
    const raw = candidate?.meta?.changes;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : null;
    if (value !== null && Number.isSafeInteger(value)) {
      changes += value;
      sawChanges = true;
    }
  }
  return sawChanges ? changes : fallback;
}

function assertCursor(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("pagination cursor is invalid");
  return value;
}

function assertPhotoId(value, label = "photo id") {
  const id = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${label} must be a positive integer`);
  return id;
}

export function assertR2Key(value, label = "r2_key") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    CONTROL_CHARACTERS.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a safe R2 key`);
  }
  return value;
}

export function assertBlurhash(value, label = "blurhash") {
  if (
    typeof value !== "string" ||
    value.length !== BLURHASH_LENGTH ||
    value[0] !== BLURHASH_SIZE_FLAG ||
    [...value].some((character) => !BLURHASH_BASE83.has(character))
  ) {
    throw new Error(`${label} is not a valid fixed-4x4 BlurHash`);
  }
  try {
    const decoded = decodeBlurhash(value, MIN_BLURHASH_AXIS, MIN_BLURHASH_AXIS);
    if (!(decoded instanceof Uint8ClampedArray) || decoded.length !== MIN_BLURHASH_AXIS * MIN_BLURHASH_AXIS * 4) {
      throw new Error("decoded hash length is invalid");
    }
  } catch {
    throw new Error(`${label} is not decodable`);
  }
  return value;
}

function sqlString(value, label) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value) || value.includes("\u0000")) {
    throw new Error(`${label} contains unsafe characters`);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build only validated, bounded UPDATE statements; object keys never enter SQL. */
export function buildUpdateSql(rows, { force = false } = {}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_SQL_BATCH_SIZE) {
    throw new Error(`SQL update batch must contain 1-${MAX_SQL_BATCH_SIZE} rows`);
  }
  const seen = new Set();
  const statements = rows.map((row) => {
    const id = assertPhotoId(row?.id);
    if (seen.has(id)) throw new Error(`SQL update batch contains duplicate photo id ${id}`);
    seen.add(id);
    const hash = assertBlurhash(row?.blurhash, `photo ${id} blurhash`);
    return [
      "UPDATE photos",
      `SET blurhash = ${sqlString(hash, `photo ${id} blurhash`)}`,
      `WHERE id = ${id}${force ? "" : " AND blurhash IS NULL"};`,
    ].join("\n");
  });
  return `${statements.join("\n")}\n`;
}

/** Cursor pagination is by immutable D1 id, not by offset. */
export function selectPageSql(cursor, limit, { force = false } = {}) {
  const safeCursor = assertCursor(cursor);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error(`page size must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  }
  const predicate = force ? `id > ${safeCursor}` : `blurhash IS NULL AND id > ${safeCursor}`;
  return `SELECT id, r2_key, blurhash\nFROM photos\nWHERE ${predicate}\nORDER BY id ASC\nLIMIT ${limit};`;
}

async function readD1Page(args, context) {
  const sql = selectPageSql(context.cursor, context.limit, { force: args.force });
  const output = await runWranglerText([
    "d1",
    "execute",
    args.d1,
    ...commandMode(args),
    "--json",
    "--command",
    sql,
  ]);
  return normaliseRows(parseJsonOutput(output, "D1 query"));
}

async function readR2Object(args, key, { signal } = {}) {
  const output = await runWranglerBytes(
    ["r2", "object", "get", `${args.bucket}/${key}`, "--pipe", ...commandMode(args)],
    args.maxDownloadBytes,
    signal,
  );
  if (output.byteLength > args.maxObjectBytes) throw new Error("original object exceeds byte limit");
  return output;
}

async function writeD1Sql(args, sqlFile) {
  const output = await runWranglerText([
    "d1",
    "execute",
    args.d1,
    ...commandMode(args),
    "--json",
    "--file",
    sqlFile,
  ]);
  return mutationChanges(parseJsonOutput(output, "D1 update"), 0);
}

function normaliseChanges(value, fallback) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (value && typeof value === "object" && typeof value.changes === "number") {
    return normaliseChanges(value.changes, fallback);
  }
  return fallback;
}

async function writeBatchDefault(args, rows, force, temporaryDirectory) {
  const sql = buildUpdateSql(rows, { force });
  const sqlFile = path.join(temporaryDirectory, `blurhash-${rows[0].id}-${rows.length}.sql`);
  await writeFile(sqlFile, sql, "utf8");
  return writeD1Sql(args, sqlFile);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function rowLabel(row) {
  try {
    return `photo ${assertPhotoId(row?.id)}`;
  } catch {
    return "photo with invalid id";
  }
}

async function processRow(args, row, dependencies, signal) {
  const id = assertPhotoId(row?.id);
  const key = assertR2Key(row?.r2_key);
  const readObject = dependencies.readObject ?? ((r2Key, context) => readR2Object(args, r2Key, context));
  const bytes = await readObject(key, {
    signal,
    bucket: args.bucket,
    maxObjectBytes: args.maxObjectBytes,
    maxDownloadBytes: args.maxDownloadBytes,
  });
  const original = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : bytes instanceof Uint8Array || Buffer.isBuffer(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : null;
  if (!original) throw new Error("R2 reader did not return bytes");
  if (original.byteLength > args.maxDownloadBytes) throw new Error("download buffer exceeds byte limit");
  if (original.byteLength > args.maxObjectBytes) throw new Error("original object exceeds byte limit");
  if (original.byteLength === 0) throw new Error("original object is empty");

  const encode = dependencies.encode ?? ((input, options) => blurhashFromOriginal(input, options));
  const blurhash = await encode(original, { maxPixels: args.maxPixels });
  assertBlurhash(blurhash, `photo ${id} blurhash`);
  return { id, r2Key: key, blurhash };
}

async function processRowWithTimeout(args, row, dependencies) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const work = processRow(args, row, dependencies, controller.signal);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`row exceeded ${args.rowTimeoutMs}ms timeout`));
    }, args.rowTimeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (timedOut) await work.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Run at most `concurrency` row jobs at once, preserving result order. */
export async function runBounded(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
  }
  let cursor = 0;
  const results = new Array(items.length);
  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, consume));
  return results;
}

async function resolveResources(args) {
  const resolved = { ...args };
  if (!resolved.d1) resolved.d1 = await readWranglerValue("database_name");
  if (!resolved.bucket) resolved.bucket = await readWranglerValue("bucket_name");
  return resolved;
}

function asDependencies(dependencies) {
  return dependencies && typeof dependencies === "object" ? dependencies : {};
}

/**
 * Execute one bounded, resumable backfill. Dependencies are injectable so all
 * tests can use fakes and no command in this module needs to touch remote data.
 */
export async function runBackfill(argvOrArgs = [], injectedDependencies = {}) {
  const dependencies = asDependencies(injectedDependencies);
  const parsed = Array.isArray(argvOrArgs) ? parseArgs(argvOrArgs) : { ...argvOrArgs };
  if (parsed.help) return { help: true, args: parsed };
  const args = await resolveResources(parsed);
  if (args.remote && (!args.d1 || !args.bucket)) {
    throw new Error("--remote requires explicit --d1 <database> and --bucket <bucket>");
  }

  const queryPage = dependencies.queryPage ?? ((context) => readD1Page(args, context));
  const successful = [];
  const problems = [];
  let cursor = 0;
  let selected = 0;
  let queryFailed = false;

  while (selected < args.limit) {
    const pageLimit = Math.min(MAX_PAGE_SIZE, args.limit - selected);
    let rows;
    try {
      rows = await queryPage({
        args,
        cursor,
        limit: pageLimit,
        force: args.force,
        sql: selectPageSql(cursor, pageLimit, { force: args.force }),
      });
    } catch (error) {
      problems.push(`D1 page after id ${cursor}: ${errorMessage(error)}`);
      queryFailed = true;
      break;
    }
    if (!Array.isArray(rows)) {
      problems.push(`D1 page after id ${cursor}: query did not return rows`);
      queryFailed = true;
      break;
    }
    if (rows.length === 0) break;
    const page = rows.slice(0, pageLimit);
    selected += page.length;

    let nextCursor = cursor;
    for (const row of page) {
      try {
        const id = assertPhotoId(row?.id);
        if (id > nextCursor) nextCursor = id;
      } catch {
        // The row will get an isolated failure below. Avoid accepting an
        // invalid cursor and potentially issuing an unsafe SQL query.
      }
    }
    if (nextCursor <= cursor) {
      problems.push(`D1 pagination stalled after id ${cursor}; invalid or non-increasing row id`);
      queryFailed = true;
      break;
    }
    cursor = nextCursor;

    const results = await runBounded(page, args.concurrency, async (row) => {
      try {
        return { row, value: await processRowWithTimeout(args, row, dependencies) };
      } catch (error) {
        const problem = `${rowLabel(row)}: ${errorMessage(error)}`;
        problems.push(problem);
        return { row, error: problem };
      }
    });
    for (const result of results) {
      if (result?.value) successful.push(result.value);
    }
  }

  const summary = {
    args,
    selected,
    decoded: successful.length,
    wouldUpdate: args.dryRun ? successful.length : 0,
    updated: 0,
    conflicted: 0,
    failed: problems.length,
    problems,
    queryFailed,
    dryRun: args.dryRun,
  };

  if (!args.dryRun && successful.length > 0) {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "img-gallery-blurhash-backfill-"));
    try {
      const writeBatch = dependencies.writeBatch
        ? ({ rows, force }) => dependencies.writeBatch({
          args,
          rows,
          force,
          sql: buildUpdateSql(rows, { force }),
        })
        : ({ rows, force }) => writeBatchDefault(args, rows, force, temporaryDirectory);

      for (let offset = 0; offset < successful.length; offset += args.sqlBatchSize) {
        const rows = successful.slice(offset, offset + args.sqlBatchSize);
        try {
          const changes = normaliseChanges(await writeBatch({ rows, force: args.force }), rows.length);
          summary.updated += Math.min(changes, rows.length);
          summary.conflicted += Math.max(0, rows.length - changes);
        } catch (batchError) {
          // A generated batch contains only validated literals. Retrying one
          // row at a time makes an external transient/SQLite failure local to
          // the affected row and keeps successful work resumable.
          for (const row of rows) {
            try {
              const changes = normaliseChanges(await writeBatch({ rows: [row], force: args.force }), 1);
              if (changes > 0) summary.updated += 1;
              else summary.conflicted += 1;
            } catch (rowError) {
              summary.problems.push(`${rowLabel(row)} update failed: ${errorMessage(rowError)}`);
            }
          }
          // Preserve a short batch-level diagnostic only if every single-row
          // retry also failed; otherwise the row diagnostics are sufficient.
          if (rows.every((row) => summary.problems.some((problem) => problem.startsWith(`${rowLabel(row)} update failed:`)))) {
            summary.problems.push(`SQL batch starting at ${rowLabel(rows[0])}: ${errorMessage(batchError)}`);
          }
        }
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  summary.failed = summary.problems.length;
  return summary;
}

function printSummary(summary) {
  if (summary.help) {
    console.log("Usage: node scripts/backfill-blurhash.mjs [--d1 <name>] [--bucket <name>] [--persist-to <dir>] [--remote] [--dry-run] [--force] [--limit <n>] [--concurrency <n>] [--sql-batch-size <n>] [--max-object-bytes <n>] [--max-download-bytes <n>] [--max-pixels <n>] [--row-timeout-ms <n>]");
    return;
  }
  console.log(
    `Backfill summary: selected ${summary.selected}, decoded ${summary.decoded}, ` +
    `${summary.dryRun ? `would update ${summary.wouldUpdate}` : `updated ${summary.updated}, conflicts ${summary.conflicted}`}, ` +
    `failed ${summary.failed}`,
  );
  if (summary.dryRun) console.log("Dry run: no D1 updates and no R2 mutations were performed.");
  if (summary.problems.length > 0) {
    console.log("Problems:");
    for (const problem of summary.problems) console.log(`- ${problem}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const summary = await runBackfill(argv);
    printSummary(summary);
    if (summary.failed > 0) process.exitCode = 1;
    return summary;
  } catch (error) {
    console.error(`backfill-blurhash: ${errorMessage(error)}`);
    process.exitCode = 1;
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export { main };
