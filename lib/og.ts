import type { Env } from "./env";

export const OG_GENERATION = "v1";
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
export const OG_CONTENT_TYPE = "image/jpeg";
export const OG_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const OG_FALLBACK_CACHE = "public, max-age=60";

/** Every generation this codebase has served. Append on a bump; never remove one. */
export const OG_GENERATIONS = ["v1"] as const;

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

  const result = await env.IMAGES.input(source.body)
    // Local wrangler does not honour gravity; verify the salient crop on a deployed preview.
    .transform({ width: OG_WIDTH, height: OG_HEIGHT, fit: "cover", gravity: "auto" })
    .output({ format: "image/jpeg", quality: 85 });
  return new Response(result.image()).arrayBuffer();
}

export async function ensureOgCard(
  env: Env,
  photoId: string,
  sourceKey: string,
): Promise<ArrayBuffer> {
  const key = ogObjectKey(photoId);
  const existing = await env.BUCKET.get(key);
  if (existing) return existing.arrayBuffer();

  const bytes = await generateOgCard(env, sourceKey);
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
): Promise<boolean> {
  try {
    await ensureOgCard(env, photoId, sourceKey);
    return true;
  } catch {
    return false;
  }
}
