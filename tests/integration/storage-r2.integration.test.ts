/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { isCanonicalPhotoBlurhash } from "../../lib/image-placeholder";
import { getObject, preprocessAndStorePhoto, validateAndStore } from "../../lib/storage";
import {
  imageFixtureArrayBuffer,
  REAL_IMAGE_FIXTURES,
} from "../helpers/image-fixtures";
import { webpVp8xFixture } from "../helpers/mock-r2";

const BLURHASH_CONTRACT_TABLE = "integration_blurhash_contract";

function workerEnv(): Env {
  return env as unknown as Env;
}

afterAll(async () => {
  await workerEnv().DB.exec(`DROP TABLE IF EXISTS ${BLURHASH_CONTRACT_TABLE}`);
});

describe("D1 transaction integration", () => {
  it("rolls back every statement when one D1 batch statement fails", async () => {
    const workerEnv = env as unknown as Env;
    await workerEnv.DB.exec(
      "CREATE TABLE integration_batch_rollback (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );

    try {
      await expect(
        workerEnv.DB.batch([
          workerEnv.DB
            .prepare("INSERT INTO integration_batch_rollback (id, value) VALUES (?, ?)")
            .bind(1, "first"),
          workerEnv.DB
            .prepare("INSERT INTO integration_batch_rollback (id, value) VALUES (?, ?)")
            .bind(1, "duplicate"),
        ]),
      ).rejects.toThrow();

      const row = await workerEnv.DB
        .prepare("SELECT COUNT(*) AS count FROM integration_batch_rollback")
        .first<{ count: number }>();
      expect(row?.count).toBe(0);
    } finally {
      await workerEnv.DB.exec("DROP TABLE integration_batch_rollback");
    }
  });
});

describe("R2 storage integration", () => {
  it("round-trips validated image bytes through the real R2 binding", async () => {
    const bytes = webpVp8xFixture(320, 180);
    const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const workerEnv = env as unknown as Env;
    const result = await validateAndStore(workerEnv, source, { prefix: "photos" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`unexpected validation failure: ${result.reason}`);

    const object = await getObject(workerEnv, result.key);
    expect(object).not.toBeNull();
    expect(object?.size).toBe(bytes.byteLength);
    expect(object?.httpMetadata?.contentType).toBe("image/webp");
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);

    await workerEnv.BUCKET.delete(result.key);
  });
});

describe("local Images upload preprocessing", () => {
  it.each(REAL_IMAGE_FIXTURES)(
    "decodes a real $name, stores a fixed-4x4 hash in D1, and preserves the original bytes",
    async (fixture) => {
      const worker = workerEnv();
      await worker.DB.exec(
        `CREATE TABLE IF NOT EXISTS ${BLURHASH_CONTRACT_TABLE} (r2_key TEXT PRIMARY KEY, content_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, blurhash TEXT)`,
      );

      const original = fixture.bytes;
      const result = await preprocessAndStorePhoto(worker, imageFixtureArrayBuffer(fixture));
      expect(result).toMatchObject({
        ok: true,
        contentType: fixture.contentType,
        ext: fixture.ext,
        width: fixture.width,
        height: fixture.height,
        size: original.byteLength,
      });
      if (!result.ok) throw new Error(`unexpected ${fixture.name} validation failure: ${result.reason}`);
      expect(isCanonicalPhotoBlurhash(result.blurhash)).toBe(true);
      expect(result.blurhash).toHaveLength(36);

      await worker.DB
        .prepare(
          `INSERT INTO ${BLURHASH_CONTRACT_TABLE} (r2_key, content_type, width, height, blurhash)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(result.key, result.contentType, result.width, result.height, result.blurhash)
        .run();
      const row = await worker.DB
        .prepare(`SELECT content_type, width, height, blurhash FROM ${BLURHASH_CONTRACT_TABLE} WHERE r2_key = ?`)
        .bind(result.key)
        .first<{ content_type: string; width: number; height: number; blurhash: string | null }>();
      expect(row).toEqual({
        content_type: fixture.contentType,
        width: fixture.width,
        height: fixture.height,
        blurhash: result.blurhash,
      });

      const object = await getObject(worker, result.key);
      expect(object).not.toBeNull();
      expect(object?.httpMetadata?.contentType).toBe(fixture.contentType);
      expect(new Uint8Array(await object!.arrayBuffer())).toEqual(original);

      await worker.BUCKET.delete(result.key);
      await worker.DB.prepare(`DELETE FROM ${BLURHASH_CONTRACT_TABLE} WHERE r2_key = ?`).bind(result.key).run();
    },
  );
});
