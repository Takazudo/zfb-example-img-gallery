export const BLURHASH_COMPONENTS: 4;
export const MIN_BLURHASH_AXIS: 4;
export const MAX_BLURHASH_AXIS: 32;
export const MAX_BLURHASH_PIXELS: 1024;
export const DEFAULT_MAX_OBJECT_BYTES: number;
export const DEFAULT_MAX_DOWNLOAD_BYTES: number;
export const DEFAULT_MAX_SHARP_PIXELS: number;

export function ensureMinimumRaster(
  pixels: Uint8Array,
  width: number,
  height: number,
): { pixels: Uint8ClampedArray; width: number; height: number };
export function blurhashFromOriginal(
  bytes: Uint8Array,
  options?: { maxPixels?: number },
): Promise<string>;
