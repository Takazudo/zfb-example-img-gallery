import { describe, expect, it, vi } from "vitest";
import { encode as encodePng } from "fast-png";
import sharp from "sharp";
import type { Env } from "../../lib/env";
import { MAX_UPLOAD_BYTES, preprocessAndStorePhoto, validateAndStore } from "../../lib/storage";
import { createMockR2, pngFixture, webpVp8xFixture } from "../helpers/mock-r2";

function envWith(bucket: R2Bucket): Env {
  return { BUCKET: bucket } as Env;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imagesBinding(output: Uint8Array, order: string[], inputBytes: Uint8Array[]): ImagesBinding {
  const transformer = {
    transform(options: ImageTransform) {
      expect(options).toEqual({ fit: "scale-down", width: 32, height: 32 });
      return transformer;
    },
    async output(options: ImageOutputOptions) {
      order.push("blurhash");
      expect(options).toEqual({ format: "image/png" });
      return {
        contentType: () => "image/png",
        response: () => new Response(buffer(output)),
        image: () => new Response(buffer(output)).body!,
      };
    },
  } as ImageTransformer;
  return Object.assign(Object.create(null), {
    input(stream: ReadableStream<Uint8Array>) {
      void new Response(stream).arrayBuffer().then((value) => inputBytes.push(new Uint8Array(value)));
      return transformer;
    },
  }) as ImagesBinding;
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

  it("validates, hashes, then stores unchanged genuine EXIF JPEG bytes", async () => {
    const order: string[] = [];
    const imageInputs: Uint8Array[] = [];
    const transformed = encodePng({
      width: 4,
      height: 4,
      channels: 4,
      depth: 8,
      data: new Uint8Array(4 * 4 * 4).fill(120),
    });
    const originalNodeBuffer = await sharp({
      create: { width: 3, height: 5, channels: 3, background: { r: 20, g: 40, b: 60 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const original = new Uint8Array(originalNodeBuffer);
    const bucket = createMockR2();
    const originalPut = bucket.put.bind(bucket);
    bucket.put = async (...args: Parameters<R2Bucket["put"]>) => {
      order.push("r2");
      return originalPut(...args);
    };
    const env = {
      BUCKET: bucket,
      IMAGES: imagesBinding(transformed, order, imageInputs),
    } as unknown as Env;

    const result = await preprocessAndStorePhoto(env, buffer(original));

    expect(result).toMatchObject({ ok: true, contentType: "image/jpeg", width: 3, height: 5 });
    expect(result.ok && result.blurhash).toHaveLength(36);
    expect(order).toEqual(["blurhash", "r2"]);
    await expect.poll(() => imageInputs.length).toBe(1);
    expect(imageInputs[0]).toEqual(original);
    expect(bucket._store.get(result.ok ? result.key : "")?.bytes).toEqual(original);
  });

  it("stores the original with a null hash when photo preprocessing fails", async () => {
    const bucket = createMockR2();
    const bytes = webpVp8xFixture(12, 8);
    const env = {
      BUCKET: bucket,
      IMAGES: Object.assign(Object.create(null), {
        input: () => { throw new Error("binding unavailable"); },
      }) as ImagesBinding,
    } as unknown as Env;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await preprocessAndStorePhoto(env, buffer(bytes));

    expect(result.ok && result.blurhash).toBeNull();
    expect(bucket._store.get(result.ok ? result.key : "")?.bytes).toEqual(bytes);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "photo_blurhash_generation_failed",
      stage: "transform",
    }));
    warning.mockRestore();
  });

  it("rejects invalid originals before invoking photo preprocessing or R2", async () => {
    const bucket = createMockR2();
    const input = vi.fn(() => { throw new Error("must not run"); });
    const env = {
      BUCKET: bucket,
      IMAGES: Object.assign(Object.create(null), { input }) as ImagesBinding,
    } as unknown as Env;

    await expect(preprocessAndStorePhoto(env, buffer(new TextEncoder().encode("not an image"))))
      .resolves.toEqual({ ok: false, reason: "unsupported-type" });
    expect(input).not.toHaveBeenCalled();
    expect(bucket._store.size).toBe(0);
  });
});
