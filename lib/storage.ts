import type { Env } from "./env";
import { readImageDimensions } from "./image-dims";

export type KeyPrefix = "photos" | "thumbs" | "avatars";
export type ImageExt = "jpg" | "png" | "webp";

const SERVABLE_KEY =
  /^(photos|thumbs|avatars)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|webp)$/;

export function buildKey(prefix: KeyPrefix, uuid: string, ext: ImageExt): string {
  return `${prefix}/${uuid}.${ext}`;
}

export function parseKey(key: string): { prefix: KeyPrefix; uuid: string; ext: ImageExt } | null {
  const match = SERVABLE_KEY.exec(key);
  if (!match) return null;
  return { prefix: match[1] as KeyPrefix, uuid: match[2], ext: match[3] as ImageExt };
}

export function isServableKey(key: string): boolean {
  return parseKey(key) !== null;
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export function sniffImageType(
  bytes: Uint8Array,
): { contentType: AllowedImageType; ext: ImageExt } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    )
  ) {
    return { contentType: "image/png", ext: "png" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", ext: "webp" };
  }
  return null;
}

/** Cheap pre-parse reject. `Content-Length` is a hint, not authoritative. */
export function contentLengthExceedsLimit(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  // A syntactically numeric value can still overflow to Infinity. Treat that
  // as oversized instead of falling through to request.formData().
  return !Number.isSafeInteger(length) || length > MAX_UPLOAD_BYTES;
}

export type StoreResult =
  | { ok: true; key: string; contentType: AllowedImageType; ext: ImageExt; size: number; width: number; height: number }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "too-large"; size: number; limit: number }
  | { ok: false; reason: "unsupported-type" }
  | { ok: false; reason: "undecodable" };

/**
 * Validates and writes image bytes to R2. Callers must write R2 first and insert
 * the D1 row only after this succeeds, avoiding rows that point at missing blobs.
 */
export async function validateAndStore(
  env: Env,
  bytes: ArrayBuffer,
  opts: { prefix: KeyPrefix },
): Promise<StoreResult> {
  const size = bytes.byteLength;
  if (size === 0) return { ok: false, reason: "empty" };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, reason: "too-large", size, limit: MAX_UPLOAD_BYTES };

  const view = new Uint8Array(bytes);
  const imageType = sniffImageType(view);
  if (!imageType) return { ok: false, reason: "unsupported-type" };
  const dimensions = readImageDimensions(view);
  if (!dimensions) return { ok: false, reason: "undecodable" };

  const key = buildKey(opts.prefix, crypto.randomUUID(), imageType.ext);
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: imageType.contentType } });
  return { ok: true, key, ...imageType, size, ...dimensions };
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.BUCKET.get(key);
}

export async function headObject(env: Env, key: string): Promise<R2Object | null> {
  return env.BUCKET.head(key);
}

export async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
): Promise<void> {
  await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
}

export const MAX_R2_DELETE_BATCH = 1000;

/**
 * Read all owned keys, delete R2 first, and delete D1 rows atomically only after
 * every R2 batch succeeds. The operation must be idempotent and safely retryable.
 */
export async function deleteObjects(env: Env, keys: string[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += MAX_R2_DELETE_BATCH) {
    await env.BUCKET.delete(keys.slice(offset, offset + MAX_R2_DELETE_BATCH));
  }
}

export async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.BUCKET.list({ prefix, cursor });
    keys.push(...result.objects.map((object) => object.key));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

export async function listPrefixes(env: Env, prefix: string): Promise<string[]> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.BUCKET.list({ prefix, delimiter: "/", cursor });
    prefixes.push(...result.delimitedPrefixes);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor !== undefined);
  return prefixes;
}
