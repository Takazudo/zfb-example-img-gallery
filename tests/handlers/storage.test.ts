import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { MAX_UPLOAD_BYTES, validateAndStore } from "../../lib/storage";
import { createMockR2, pngFixture, webpVp8xFixture } from "../helpers/mock-r2";

function envWith(bucket: R2Bucket): Env {
  return { BUCKET: bucket } as Env;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("validateAndStore", () => {
  it.each([
    ["empty", new Uint8Array(), { ok: false, reason: "empty" }],
    ["too large", new Uint8Array(MAX_UPLOAD_BYTES + 1), {
      ok: false, reason: "too-large", size: MAX_UPLOAD_BYTES + 1, limit: MAX_UPLOAD_BYTES,
    }],
    ["unsupported", new TextEncoder().encode("hello"), { ok: false, reason: "unsupported-type" }],
    ["undecodable", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      ok: false, reason: "undecodable",
    }],
  ])("rejects %s bytes without writing", async (_name, bytes, expected) => {
    const bucket = createMockR2();
    expect(await validateAndStore(envWith(bucket), buffer(bytes), { prefix: "photos" })).toEqual(expected);
    expect(bucket._store.size).toBe(0);
  });

  it("stores WebP with sniffed metadata and dimensions", async () => {
    const bucket = createMockR2();
    const bytes = webpVp8xFixture(1920, 1080);
    const result = await validateAndStore(envWith(bucket), buffer(bytes), { prefix: "photos" });

    expect(result).toMatchObject({
      ok: true, contentType: "image/webp", ext: "webp", size: bytes.byteLength,
      width: 1920, height: 1080,
    });
    expect(result.ok && result.key).toMatch(/^photos\/[0-9a-f-]{36}\.webp$/);
    expect(bucket._store.size).toBe(1);
    expect(bucket._store.get(result.ok ? result.key : "")?.contentType).toBe("image/webp");
  });

  it("stores an avatar PNG under the avatar prefix", async () => {
    const bucket = createMockR2();
    const result = await validateAndStore(envWith(bucket), buffer(pngFixture(128, 256)), { prefix: "avatars" });
    expect(result.ok && result.key).toMatch(/^avatars\/[0-9a-f-]{36}\.png$/);
    expect(bucket._store.size).toBe(1);
  });
});
