import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import {
  OG_GENERATIONS,
  ensureOgCard,
  ogObjectKey,
  ogObjectKeysForPhoto,
  tryGenerateOgCard,
} from "../../lib/og";
import { createMockR2, jpegFixture, pngFixture } from "../helpers/mock-r2";

function imagesBinding(output = jpegFixture(1200, 630), shouldFail = false): ImagesBinding {
  return Object.assign(Object.create(null), {
    input: vi.fn(() => {
      if (shouldFail) throw new Error("transform unavailable");
      return {
        transform: vi.fn().mockReturnThis(),
        output: vi.fn(async () => ({ image: () => new Response(output.slice().buffer).body! })),
      };
    }),
  });
}

function envFor(images: ImagesBinding): Env {
  return Object.assign(Object.create(null), { BUCKET: createMockR2(), IMAGES: images });
}

describe("OG card helpers", () => {
  it("returns one derived key for every retained generation", () => {
    expect(ogObjectKeysForPhoto("photo-7")).toEqual(
      OG_GENERATIONS.map((generation) => `derived/og/${generation}/photo-7.jpg`),
    );
  });

  it("persists one generated card and reuses it", async () => {
    const images = imagesBinding();
    const env = envFor(images);
    await env.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await ensureOgCard(env, "7", "photos/source.png");
    await ensureOgCard(env, "7", "photos/source.png");
    expect(images.input).toHaveBeenCalledTimes(1);
    expect(await env.BUCKET.get(ogObjectKey("7"))).not.toBeNull();
  });

  it("never rejects from the write-through hook", async () => {
    const failing = envFor(imagesBinding(jpegFixture(1200, 630), true));
    await failing.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await expect(tryGenerateOgCard(failing, "7", "photos/source.png")).resolves.toBe(false);

    const working = envFor(imagesBinding());
    await working.BUCKET.put("photos/source.png", pngFixture(100, 100));
    await expect(tryGenerateOgCard(working, "7", "photos/source.png")).resolves.toBe(true);
  });
});
