/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { getObject, validateAndStore } from "../../lib/storage";
import { webpVp8xFixture } from "../helpers/mock-r2";

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
