import type { Env } from "./env";
import {
  BLEED,
  BOX,
  SHADOW_BLUR,
  SHADOW_BOX,
  SHADOW_OPACITY,
} from "./og-card-layout.mjs";

export const OG_GENERATION = "v2";
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_CONTENT_TYPE = "image/jpeg";
export const OG_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const OG_FALLBACK_CACHE = "public, max-age=60";

/** Every generation this codebase has served. Append on a bump; never remove one. */
export const OG_GENERATIONS = ["v1", "v2"] as const;

export type OgCardRenderer = (env: Env, sourceKey: string) => Promise<ArrayBuffer>;

const OG_PLATE_PATH = "/og-plate.png";
const OG_SHADOW_FILL_PATH = "/og-shadow-fill.png";

function streamFrom(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

async function assetStream(env: Env, path: string): Promise<ReadableStream<Uint8Array>> {
  const response = await env.ASSETS.fetch(new URL(path, "https://assets.invalid"));
  if (!response.ok || !response.body) throw new Error(`og: asset unavailable: ${path}`);
  return response.body;
}

async function renderCoverCard(
  env: Env,
  sourceStream: ReadableStream<Uint8Array>,
): Promise<ArrayBuffer> {
  const result = await env.IMAGES.input(sourceStream)
    // Local wrangler does not honour gravity; verify the salient crop on a deployed preview.
    .transform({ width: OG_WIDTH, height: OG_HEIGHT, fit: "cover", gravity: "auto" })
    .output({ format: "image/jpeg", quality: 85 });
  return new Response(result.image()).arrayBuffer();
}

export function ogObjectKey(photoId: string, generation: string = OG_GENERATION): string {
  return `derived/og/${generation}/${photoId}.jpg`;
}

export function ogImagePath(photoId: string, generation: string = OG_GENERATION): string {
  return `/og/${generation}/${photoId}.jpg`;
}

export function ogObjectKeysForPhoto(photoId: string): string[] {
  return OG_GENERATIONS.map((generation) => ogObjectKey(photoId, generation));
}

export async function generateOgCard(env: Env, sourceKey: string): Promise<ArrayBuffer> {
  const source = await env.BUCKET.get(sourceKey);
  if (!source) throw new Error(`og: source object missing: ${sourceKey}`);

  return renderCoverCard(env, source.body);
}

export async function generateOgCompositeCard(env: Env, sourceKey: string): Promise<ArrayBuffer> {
  const source = await env.BUCKET.get(sourceKey);
  if (!source) throw new Error(`og: source object missing: ${sourceKey}`);

  // Images streams and transformers are single-use. Buffer the R2 object once, then create a
  // fresh stream and transformer for every photo, shadow, and cover-degradation branch.
  const sourceBytes = await source.arrayBuffer();
  try {
    const photoLayer = env.IMAGES.input(streamFrom(sourceBytes)).transform({
      width: BOX.width,
      height: BOX.height,
      fit: "pad",
      background: "transparent",
    });
    const shadowLayer = env.IMAGES.input(streamFrom(sourceBytes))
      .transform({
        width: BOX.width,
        height: BOX.height,
        fit: "pad",
        background: "transparent",
      })
      // The fill asset is deliberately 1x1. Images draw overlays only within their own bounds
      // unless repeat is enabled, so tile it across the padded photo before masking its alpha.
      .draw(env.IMAGES.input(await assetStream(env, OG_SHADOW_FILL_PATH)), {
        composite: "in",
        repeat: true,
      })
      .transform({ border: { color: "rgba(0,0,0,0)", width: BLEED } })
      .transform({ blur: SHADOW_BLUR });
    const result = await env.IMAGES.input(await assetStream(env, OG_PLATE_PATH))
      .draw(shadowLayer, {
        left: SHADOW_BOX.x,
        top: SHADOW_BOX.y,
        opacity: SHADOW_OPACITY,
      })
      .draw(photoLayer, { left: BOX.x, top: BOX.y })
      .output({ format: "image/jpeg", quality: 88 });
    return new Response(result.image()).arrayBuffer();
  } catch {
    // Preserve a photo-specific card when only composition is unavailable. If Images itself is
    // unavailable this also rejects, allowing the route to serve the short-lived static fallback.
    return renderCoverCard(env, streamFrom(sourceBytes));
  }
}

export async function ensureOgCard(
  env: Env,
  photoId: string,
  sourceKey: string,
  generation: string = OG_GENERATION,
  renderer: OgCardRenderer = generateOgCompositeCard,
): Promise<ArrayBuffer> {
  const key = ogObjectKey(photoId, generation);
  const existing = await env.BUCKET.get(key);
  if (existing) return existing.arrayBuffer();

  const bytes = await renderer(env, sourceKey);
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: OG_CONTENT_TYPE, cacheControl: OG_IMMUTABLE_CACHE },
  });
  // Concurrent misses may duplicate one transform; identical R2 puts make that harmless.
  // Normally this spends one of the 5,000 free transformations/month per photo and generation.
  return bytes;
}

export async function tryGenerateOgCard(
  env: Env,
  photoId: string,
  sourceKey: string,
  generation: string = OG_GENERATION,
  renderer: OgCardRenderer = generateOgCompositeCard,
): Promise<boolean> {
  try {
    await ensureOgCard(env, photoId, sourceKey, generation, renderer);
    return true;
  } catch {
    return false;
  }
}
