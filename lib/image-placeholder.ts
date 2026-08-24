import { decode } from "blurhash";
import { encode as encodePng } from "fast-png";

const BASE83_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";
const BASE83 = new Set(BASE83_ALPHABET);
const COMPONENTS = 4;
const SIZE_FLAG = (COMPONENTS - 1) + (COMPONENTS - 1) * 9;
const HASH_LENGTH = 4 + 2 * COMPONENTS * COMPONENTS;

export const PLACEHOLDER_MAX_SOURCE_AXIS = 100_000;
export const PLACEHOLDER_MAX_DECODE_AXIS = 16;
export const PLACEHOLDER_MIN_DECODE_AXIS = 4;
export const PLACEHOLDER_MAX_PIXELS = PLACEHOLDER_MAX_DECODE_AXIS ** 2;
export const PLACEHOLDER_MAX_DATA_URI_BYTES = 4 * 1024;

export type ImagePlaceholder = {
  dataUri: string;
  width: number;
  height: number;
};

export function isCanonicalPhotoBlurhash(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== HASH_LENGTH) return false;
  if (BASE83_ALPHABET.indexOf(value[0] ?? "") !== SIZE_FLAG) return false;
  for (const character of value) if (!BASE83.has(character)) return false;
  return true;
}

function boundedDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(PLACEHOLDER_MAX_SOURCE_AXIS, Math.max(1, Math.round(value)));
}

/** Preserve the stored aspect ratio while keeping decode work at a fixed tiny budget. */
export function placeholderDimensions(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const width = boundedDimension(sourceWidth);
  const height = boundedDimension(sourceHeight);
  if (width >= height) {
    return {
      width: PLACEHOLDER_MAX_DECODE_AXIS,
      height: Math.max(PLACEHOLDER_MIN_DECODE_AXIS, Math.round(PLACEHOLDER_MAX_DECODE_AXIS * height / width)),
    };
  }
  return {
    width: Math.max(PLACEHOLDER_MIN_DECODE_AXIS, Math.round(PLACEHOLDER_MAX_DECODE_AXIS * width / height)),
    height: PLACEHOLDER_MAX_DECODE_AXIS,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  if (typeof btoa === "function") return btoa(binary);
  // The fallback is deliberately local and dependency-free for non-browser SSR tests.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];
    encoded += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    encoded += index + 2 < bytes.length ? alphabet[c & 63] : "=";
  }
  return encoded;
}

/** Best-effort bounded SSR conversion. Invalid database values never reach markup. */
export function createImagePlaceholder(
  blurhash: unknown,
  sourceWidth: number,
  sourceHeight: number,
): ImagePlaceholder | null {
  if (!isCanonicalPhotoBlurhash(blurhash)) return null;
  try {
    const dimensions = placeholderDimensions(sourceWidth, sourceHeight);
    if (dimensions.width * dimensions.height > PLACEHOLDER_MAX_PIXELS) return null;
    const pixels = decode(blurhash, dimensions.width, dimensions.height);
    if (pixels.byteLength !== dimensions.width * dimensions.height * 4) return null;
    const png = encodePng({ ...dimensions, data: pixels, depth: 8, channels: 4 });
    const dataUri = `data:image/png;base64,${base64(png)}`;
    if (new TextEncoder().encode(dataUri).byteLength > PLACEHOLDER_MAX_DATA_URI_BYTES) return null;
    return { dataUri, ...dimensions };
  } catch {
    return null;
  }
}
