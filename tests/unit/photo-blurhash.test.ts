import { encode as encodePng } from "fast-png";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import {
  blurhashFromTransformedPng,
  decodeTransformedPng,
  MAX_TRANSFORMED_PNG_BYTES,
  tryGeneratePhotoBlurhash,
} from "../../lib/photo-blurhash";

function png(width: number, height: number, channels: 1 | 2 | 3 | 4, data: number[]): Uint8Array {
  return encodePng({ width, height, channels, depth: 8, data: new Uint8Array(data) });
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function imagesReturning(bytes: Uint8Array, capture?: {
  source?: Uint8Array;
  transform?: ImageTransform;
  output?: ImageOutputOptions;
}): ImagesBinding {
  const transformer = {
    transform(options: ImageTransform) {
      if (capture) capture.transform = options;
      return transformer;
    },
    async output(options: ImageOutputOptions) {
      if (capture) capture.output = options;
      return {
        contentType: () => "image/png",
        response: () => new Response(body(bytes)),
        image: () => new Response(body(bytes)).body!,
      };
    },
  } as ImageTransformer;
  return Object.assign(Object.create(null), {
    input(stream: ReadableStream<Uint8Array>) {
      if (capture) {
        void new Response(stream).arrayBuffer().then((value) => {
          capture.source = new Uint8Array(value);
        });
      }
      return transformer;
    },
  }) as ImagesBinding;
}

function envWith(images: ImagesBinding): Env {
  return { IMAGES: images } as Env;
}

describe("photo BlurHash preprocessing", () => {
  it.each([
    {
      name: "grayscale",
      channels: 1 as const,
      input: [12, 220],
      expected: [12, 12, 12, 255, 220, 220, 220, 255],
    },
    {
      name: "grayscale alpha",
      channels: 2 as const,
      input: [12, 0, 220, 128],
      expected: [12, 12, 12, 0, 220, 220, 220, 128],
    },
    {
      name: "RGB",
      channels: 3 as const,
      input: [10, 20, 30, 40, 50, 60],
      expected: [10, 20, 30, 255, 40, 50, 60, 255],
    },
    {
      name: "RGBA transparency",
      channels: 4 as const,
      input: [10, 20, 30, 0, 40, 50, 60, 200],
      expected: [10, 20, 30, 0, 40, 50, 60, 200],
    },
  ])("normalises a genuinely decoded $name PNG to RGBA", ({ channels, input, expected }) => {
    const result = decodeTransformedPng(png(2, 1, channels, input));
    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect([...result.pixels]).toEqual(expected);
  });

  it("encodes deterministic fixed-4x4 hashes and upscales accepted thin images", () => {
    expect(blurhashFromTransformedPng(png(1, 1, 4, [12, 34, 56, 128])))
      .toBe("U21WZqt:fQt:t:kYfQkYfQfQfQfQt:kYfQkY");
    expect(blurhashFromTransformedPng(png(1, 5, 3, [
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      255, 255, 255,
      0, 0, 0,
    ]))).toBe("U~Jkl#-;fQ-;?Bt4fQt4vJnMfQnM}.$#fQ$#");
  });

  it.each([
    ["zero width", { width: 0 }],
    ["axis above 32", { width: 33 }],
    ["16-bit depth", { depth: 16 }],
    ["indexed colour", { colour: 3 }],
    ["interlaced", { interlace: 1 }],
  ])("rejects %s before decoding", (_name, rawChange) => {
    const change = rawChange as Partial<{
      width: number;
      depth: number;
      colour: number;
      interlace: number;
    }>;
    const bytes = png(4, 4, 4, new Array(4 * 4 * 4).fill(10)).slice();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (change.width !== undefined) view.setUint32(16, change.width);
    if (change.depth !== undefined) bytes[24] = change.depth;
    if (change.colour !== undefined) bytes[25] = change.colour;
    if (change.interlace !== undefined) bytes[28] = change.interlace;
    expect(() => decodeTransformedPng(bytes)).toThrow();
  });

  it("rejects IDAT expansion above and below the exact decoded scanline budget", () => {
    const tooMuchData = png(4, 8, 4, new Array(4 * 8 * 4).fill(10)).slice();
    new DataView(tooMuchData.buffer).setUint32(20, 4);
    expect(() => decodeTransformedPng(tooMuchData)).toThrow("exceeds pixel budget");

    const tooLittleData = png(4, 2, 4, new Array(4 * 2 * 4).fill(10)).slice();
    new DataView(tooLittleData.buffer).setUint32(20, 4);
    expect(() => decodeTransformedPng(tooLittleData)).toThrow("is inconsistent");
  });

  it("uses a fresh original-byte stream and the bounded scale-down PNG contract", async () => {
    const capture: { source?: Uint8Array; transform?: ImageTransform; output?: ImageOutputOptions } = {};
    const transformed = png(4, 4, 3, new Array(4 * 4 * 3).fill(90));
    const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66]);
    await expect(tryGeneratePhotoBlurhash(envWith(imagesReturning(transformed, capture)), original.buffer))
      .resolves.toHaveLength(36);
    await vi.waitFor(() => expect(capture.source).toEqual(original));
    expect(capture.transform).toEqual({ fit: "scale-down", width: 32, height: 32 });
    expect(capture.output).toEqual({ format: "image/png" });
  });

  it("caps transformed encoded bytes before buffering and degrades with a safe warning", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const oversized = new Uint8Array(MAX_TRANSFORMED_PNG_BYTES + 1);
    await expect(tryGeneratePhotoBlurhash(envWith(imagesReturning(oversized)), new ArrayBuffer(1)))
      .resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith({
      event: "photo_blurhash_generation_failed",
      stage: "buffer",
      errorType: "Error",
    });
    warning.mockRestore();
  });
});
