/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { getObject, validateAndStore } from "../../lib/storage";
import { webpVp8xFixture } from "../helpers/mock-r2";

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
