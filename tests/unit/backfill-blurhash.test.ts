import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  MAX_OBJECT_BYTES,
  MAX_SHARP_PIXELS,
  assertBlurhash,
  buildUpdateSql,
  parseArgs,
  runBackfill,
  selectPageSql,
} from "../../scripts/backfill-blurhash.mjs";
import { blurhashFromOriginal } from "../../scripts/lib/blurhash-backfill.mjs";

const HASH = "U32P#[t:fQt:t:o#fQo#fQfQfQfQt:o#fQo#";

async function imageBytes(width = 2, height = 3): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
  }).png().toBuffer());
}

describe("legacy BlurHash backfill", () => {
  it("parses bounded flags and requires both names in remote mode", () => {
    expect(parseArgs(["--d1", "test-db", "--bucket", "test-bucket", "--remote", "--limit", "2"])).toMatchObject({
      d1: "test-db",
      bucket: "test-bucket",
      remote: true,
      limit: 2,
    });
    expect(() => parseArgs(["--remote", "--d1", "test-db"])).toThrow(/explicit --d1 .* --bucket/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseArgs(["--concurrency", "17"])).toThrow(/--concurrency/);
    expect(() => parseArgs(["--max-object-bytes", String(MAX_OBJECT_BYTES), "--max-download-bytes", "1"]))
      .toThrow(/cannot exceed/);
  });

  it("uses an id cursor and keeps the null predicate conditional on force", () => {
    expect(selectPageSql(12, 3)).toContain("WHERE blurhash IS NULL AND id > 12");
    expect(selectPageSql(12, 3, { force: true })).toContain("WHERE id > 12");
    expect(selectPageSql(12, 3, { force: true })).not.toContain("blurhash IS NULL");
    expect(() => selectPageSql(0, 101)).toThrow(/page size/);
  });

  it("validates generated hashes and emits safe conditional/forced SQL", () => {
    const sql = buildUpdateSql([{ id: 7, blurhash: HASH }]);
    expect(sql).toContain("SET blurhash = '");
    expect(sql).toContain("WHERE id = 7 AND blurhash IS NULL;");
    expect(buildUpdateSql([{ id: 7, blurhash: HASH }], { force: true }))
      .toContain("WHERE id = 7;");
    expect(() => buildUpdateSql([{ id: "7 OR 1=1", blurhash: HASH }])).toThrow(/positive integer/);
    expect(() => buildUpdateSql([{ id: 7, blurhash: "not-a-hash" }])).toThrow(/valid fixed-4x4/);
    expect(() => assertBlurhash("%C9H2_~q%Mt7fQfQ%Mt7fQfQ%Mt7fQfQ%Mt7")).toThrow(/valid fixed-4x4/);
  });

  it("encodes small originals with the fixed 4x4 contract", async () => {
    const hash = await blurhashFromOriginal(await imageBytes(1, 1));
    expect(hash).toHaveLength(36);
    expect(hash).toBe(await blurhashFromOriginal(await imageBytes(1, 1)));
  });

  it("pages by cursor, honours --limit, bounds concurrency, and keeps dry-run mutation-free", async () => {
    const bytes = await imageBytes();
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      r2_key: `photos/${index + 1}.png`,
      blurhash: null,
    }));
    const pages: Array<{ cursor: number; limit: number; sql: string }> = [];
    const writes: unknown[] = [];
    let active = 0;
    let peak = 0;
    const summary = await runBackfill([
      "--d1", "local",
      "--bucket", "local",
      "--dry-run",
      "--limit", "5",
      "--concurrency", "2",
      "--row-timeout-ms", "1000",
    ], {
      queryPage: async ({ cursor, limit, sql }: { cursor: number; limit: number; sql: string }) => {
        pages.push({ cursor, limit, sql });
        return rows.filter((row) => row.id > cursor).slice(0, Math.min(limit, 2));
      },
      readObject: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return bytes;
      },
      writeBatch: async (input: unknown) => {
        writes.push(input);
        return 1;
      },
    });
    expect(summary).toMatchObject({ selected: 5, decoded: 5, wouldUpdate: 5, updated: 0, failed: 0 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(pages.map((page) => page.cursor)).toEqual([0, 2, 4]);
    expect(pages.every((page) => page.limit <= 5)).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it("isolates object/decode failures and still writes successful rows", async () => {
    const bytes = await imageBytes();
    const writes: Array<{ rows: Array<{ id: number; blurhash: string }>; sql: string }> = [];
    const summary = await runBackfill(["--d1", "local", "--bucket", "local", "--limit", "3"], {
      queryPage: async ({ cursor, limit }: { cursor: number; limit: number }) => {
        const rows = [
          { id: 1, r2_key: "photos/ok.png", blurhash: null },
          { id: 2, r2_key: "photos/missing.png", blurhash: null },
          { id: 3, r2_key: "photos/oversized.png", blurhash: null },
        ];
        return rows.filter((row) => row.id > cursor).slice(0, limit);
      },
      readObject: async (key: string) => {
        if (key.endsWith("missing.png")) throw new Error("object not found");
        if (key.endsWith("oversized.png")) return new Uint8Array(MAX_OBJECT_BYTES + 1);
        return bytes;
      },
      writeBatch: async ({ rows, sql }: { rows: Array<{ id: number; blurhash: string }>; sql: string }) => {
        writes.push({ rows, sql });
        return rows.length;
      },
    });
    expect(summary).toMatchObject({ selected: 3, decoded: 1, updated: 1, failed: 2 });
    expect(writes).toHaveLength(1);
    expect(writes[0].rows.map((row) => row.id)).toEqual([1]);
    expect(summary.problems.join("\n")).toContain("photo 2: object not found");
    expect(summary.problems.join("\n")).toContain("photo 3: download buffer exceeds byte limit");
  });

  it("keeps partial SQL failures resumable and supports forced updates", async () => {
    const bytes = await imageBytes();
    const writes: string[] = [];
    let failBatch = true;
    const rows = [
      { id: 1, r2_key: "photos/1.png", blurhash: "old" },
      { id: 2, r2_key: "photos/2.png", blurhash: "old" },
    ];
    const summary = await runBackfill([
      "--d1", "local", "--bucket", "local", "--force", "--sql-batch-size", "2",
    ], {
      queryPage: async ({ cursor, limit }: { cursor: number; limit: number }) => rows.filter((row) => row.id > cursor).slice(0, limit),
      readObject: async () => bytes,
      writeBatch: async ({ rows: batch, sql }: { rows: Array<{ id: number; blurhash: string }>; sql: string }) => {
        writes.push(sql);
        if (failBatch && batch.length === 2) {
          failBatch = false;
          throw new Error("temporary SQL failure");
        }
        return batch.length;
      },
    });
    expect(summary.updated).toBe(2);
    expect(summary.failed).toBe(0);
    expect(writes[0]).not.toContain("blurhash IS NULL");
    expect(writes.slice(1)).toHaveLength(2);
  });

  it("writes successful earlier pages even when a later D1 page fails", async () => {
    const bytes = await imageBytes();
    const writes: number[] = [];
    const summary = await runBackfill(["--d1", "local", "--bucket", "local", "--limit", "2"], {
      queryPage: async ({ cursor }: { cursor: number }) => {
        if (cursor === 0) return [{ id: 1, r2_key: "photos/1.png", blurhash: null }];
        throw new Error("temporary D1 read failure");
      },
      readObject: async () => bytes,
      writeBatch: async ({ rows: batch }: { rows: Array<{ id: number; blurhash: string }> }) => {
        writes.push(batch.length);
        return batch.length;
      },
    });
    expect(summary.queryFailed).toBe(true);
    expect(summary.updated).toBe(1);
    expect(writes).toEqual([1]);
    expect(summary.problems.join("\n")).toContain("temporary D1 read failure");
  });

  it("does no work on a second normal run after successful updates", async () => {
    const bytes = await imageBytes();
    const rows = [{ id: 1, r2_key: "photos/1.png", blurhash: null as string | null }];
    let queryCalls = 0;
    let updates = 0;
    const dependencies = {
      queryPage: async ({ cursor, limit }: { cursor: number; limit: number }) => {
        queryCalls += 1;
        return rows.filter((row) => row.id > cursor && row.blurhash === null).slice(0, limit);
      },
      readObject: async () => bytes,
      writeBatch: async ({ rows: batch }: { rows: Array<{ id: number; blurhash: string }> }) => {
        updates += batch.length;
        rows[0].blurhash = batch[0].blurhash;
        return batch.length;
      },
    };
    const first = await runBackfill(["--d1", "local", "--bucket", "local"], dependencies);
    const second = await runBackfill(["--d1", "local", "--bucket", "local"], dependencies);
    expect(first.updated).toBe(1);
    expect(second).toMatchObject({ selected: 0, decoded: 0, updated: 0, failed: 0 });
    expect(updates).toBe(1);
    expect(queryCalls).toBe(3);
  });

  it("enforces the Sharp pixel bound before an oversized raster is decoded", async () => {
    const bytes = await imageBytes();
    await expect(blurhashFromOriginal(bytes, { maxPixels: 1 })).rejects.toThrow();
    expect(MAX_SHARP_PIXELS).toBeGreaterThan(32 * 32);
  });
});
