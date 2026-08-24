import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { readImageDimensions } from "../../lib/image-dims";
import { BLEED, BOX, SHADOW_BLUR, SHADOW_BOX, SHADOW_OPACITY } from "../../lib/og-card-layout.mjs";
import {
  OG_GENERATIONS,
  ensureOgCard,
  generateOgCompositeCard,
  ogObjectKey,
  ogObjectKeysForPhoto,
  tryGenerateOgCard,
} from "../../lib/og";
import { createMockR2, jpegFixture, pngFixture } from "../helpers/mock-r2";

type ImagesMockOptions = {
  failAll?: boolean;
  failComposite?: boolean;
  output?: Uint8Array;
};

function imagesBinding(options: ImagesMockOptions = {}) {
  const events: Array<{
    type: "transform" | "draw" | "output";
    transformer: number;
    argument?: unknown;
    image?: number;
  }> = [];
  const streams: ReadableStream<Uint8Array>[] = [];
  const transformerIds = new WeakMap<object, number>();
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => {
    if (options.failAll) throw new Error("transform unavailable");
    const id = streams.length;
    streams.push(stream);
    const transformer: ImageTransformer = {
      transform: vi.fn((argument: ImageTransform): ImageTransformer => {
        events.push({ type: "transform", transformer: id, argument });
        return transformer;
      }),
      draw: vi.fn((
        image: ReadableStream<Uint8Array> | ImageTransformer,
        argument?: ImageDrawOptions,
      ): ImageTransformer => {
        events.push({
          type: "draw",
          transformer: id,
          argument,
          image: typeof image === "object" ? transformerIds.get(image) : undefined,
        });
        if (options.failComposite && argument?.left === SHADOW_BOX.x) {
          throw new Error("draw unavailable");
        }
        return transformer;
      }),
      output: vi.fn(async (argument: ImageOutputOptions): Promise<ImageTransformationResult> => {
        events.push({ type: "output", transformer: id, argument });
        const output = options.output ?? jpegFixture(1200, 630);
        const response = (responseOptions?: ImageTransformationResponseOptions) => new Response(
          output.slice().buffer as ArrayBuffer,
          { headers: responseOptions?.headers },
        );
        return {
          image: () => response().body!,
          response,
          contentType: () => "image/jpeg",
        };
      }),
    };
    transformerIds.set(transformer, id);
    return transformer;
  });
  const binding: ImagesBinding = Object.assign(Object.create(null), { input });
  return { binding, events, input, streams };
}

function assetsBinding(): Fetcher {
  return Object.assign(Object.create(null), {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      const bytes = pathname === "/og-plate.png" ? pngFixture(1200, 630) : pngFixture(1, 1);
      return new Response(bytes.slice().buffer as ArrayBuffer);
    }),
  });
}

function envFor(images: ImagesBinding): Env {
  return Object.assign(Object.create(null), {
    BUCKET: createMockR2(),
    IMAGES: images,
    ASSETS: assetsBinding(),
  });
}

describe("OG card helpers", () => {
  it("returns one derived key for every retained generation", () => {
    expect(ogObjectKeysForPhoto("photo-7")).toEqual(
      OG_GENERATIONS.map((generation) => `derived/og/${generation}/photo-7.jpg`),
    );
  });

  it("persists and reuses a composite card for the current-generation defaults", async () => {
    const images = imagesBinding();
    const env = envFor(images.binding);
    await env.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await ensureOgCard(env, "7", "photos/source.png");
    await ensureOgCard(env, "7", "photos/source.png");
    expect(images.input).toHaveBeenCalledTimes(4);
    expect(images.events.filter((event) => event.type === "draw")).toHaveLength(3);
    expect(await env.BUCKET.get(ogObjectKey("7"))).not.toBeNull();
  });

  it("composes the v2 plate with fresh inputs and draws shadow before photo", async () => {
    const images = imagesBinding();
    const env = envFor(images.binding);
    await env.BUCKET.put("photos/source.png", pngFixture(800, 600));

    await ensureOgCard(env, "7", "photos/source.png", "v2", generateOgCompositeCard);
    await ensureOgCard(env, "7", "photos/source.png", "v2", generateOgCompositeCard);

    expect(images.input).toHaveBeenCalledTimes(4);
    expect(new Set(images.streams).size).toBe(4);
    const inputDimensions = await Promise.all(images.streams.map(async (stream) => (
      readImageDimensions(new Uint8Array(await new Response(stream).arrayBuffer()))
    )));
    expect(inputDimensions).toEqual([
      { width: 800, height: 600 },
      { width: 800, height: 600 },
      { width: 1, height: 1 },
      { width: 1200, height: 630 },
    ]);
    expect(images.events).toContainEqual({
      type: "transform",
      transformer: 0,
      argument: { width: BOX.width, height: BOX.height, fit: "pad", background: "transparent" },
    });
    expect(images.events).toContainEqual({
      type: "transform",
      transformer: 1,
      argument: { border: { color: "rgba(0,0,0,0)", width: BLEED } },
    });
    expect(images.events).toContainEqual({
      type: "transform",
      transformer: 1,
      argument: { blur: SHADOW_BLUR },
    });
    expect(images.events.filter((event) => event.type === "draw")).toEqual([
      { type: "draw", transformer: 1, image: 2, argument: { composite: "in", repeat: true } },
      {
        type: "draw",
        transformer: 3,
        image: 1,
        argument: { left: SHADOW_BOX.x, top: SHADOW_BOX.y, opacity: SHADOW_OPACITY },
      },
      { type: "draw", transformer: 3, image: 0, argument: { left: BOX.x, top: BOX.y } },
    ]);
    expect(images.events.at(-1)).toEqual({
      type: "output",
      transformer: 3,
      argument: { format: "image/jpeg", quality: 88 },
    });
  });

  it("degrades a composite-only failure to a fresh cover transform", async () => {
    const images = imagesBinding({ failComposite: true });
    const env = envFor(images.binding);
    await env.BUCKET.put("photos/source.png", pngFixture(800, 600));

    await expect(generateOgCompositeCard(env, "photos/source.png")).resolves.toBeInstanceOf(ArrayBuffer);

    expect(images.input).toHaveBeenCalledTimes(5);
    expect(new Set(images.streams).size).toBe(5);
    const sourceBranchDimensions = await Promise.all(
      [images.streams[0], images.streams[1], images.streams[4]].map(async (stream) => (
        readImageDimensions(new Uint8Array(await new Response(stream).arrayBuffer()))
      )),
    );
    expect(sourceBranchDimensions).toEqual(Array(3).fill({ width: 800, height: 600 }));
    expect(images.events.at(-2)).toEqual({
      type: "transform",
      transformer: 4,
      argument: { width: 1200, height: 630, fit: "cover", gravity: "auto" },
    });
    expect(images.events.at(-1)).toEqual({
      type: "output",
      transformer: 4,
      argument: { format: "image/jpeg", quality: 85 },
    });
  });

  it("never rejects from the write-through hook", async () => {
    const failing = envFor(imagesBinding({ failAll: true }).binding);
    await failing.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await expect(
      tryGenerateOgCard(failing, "7", "photos/source.png", "v2", generateOgCompositeCard),
    ).resolves.toBe(false);

    const working = envFor(imagesBinding().binding);
    await working.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await expect(tryGenerateOgCard(working, "7", "photos/source.png")).resolves.toBe(true);
  });
});
