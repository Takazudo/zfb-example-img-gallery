import sharp from "sharp";
import { encode as encodeBlurhash } from "blurhash";

export const BLURHASH_COMPONENTS = 4;
export const MIN_BLURHASH_AXIS = 4;
export const MAX_BLURHASH_AXIS = 32;
export const MAX_BLURHASH_PIXELS = MAX_BLURHASH_AXIS * MAX_BLURHASH_AXIS;

/** The ordinary upload cap is also the safest default for a maintenance read. */
export const DEFAULT_MAX_OBJECT_BYTES = 4 * 1024 * 1024;
/** Keep the process-level stdout/body buffer independently bounded. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = DEFAULT_MAX_OBJECT_BYTES;
/** A compressed image can otherwise expand to an unbounded Sharp raster. */
export const DEFAULT_MAX_SHARP_PIXELS = 16_000_000;

/**
 * Upscale a small RGBA raster by nearest-neighbour replication. This mirrors
 * the Worker-side minimum-4x4 contract without bringing Sharp into the Worker
 * bundle.
 */
export function ensureMinimumRaster(pixels, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("decoded raster dimensions are invalid");
  }
  const source = pixels instanceof Uint8ClampedArray
    ? pixels
    : new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (source.length !== width * height * 4) throw new Error("decoded raster is not RGBA");

  const targetWidth = Math.max(MIN_BLURHASH_AXIS, width);
  const targetHeight = Math.max(MIN_BLURHASH_AXIS, height);
  if (targetWidth === width && targetHeight === height) return { pixels: source, width, height };

  const resized = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / targetWidth));
      const sourceOffset = (sourceY * width + sourceX) * 4;
      resized.set(source.subarray(sourceOffset, sourceOffset + 4), (y * targetWidth + x) * 4);
    }
  }
  return { pixels: resized, width: targetWidth, height: targetHeight };
}

/**
 * Decode one original with the same output contract as upload-time generation:
 * auto-orient, scale down to at most 32x32, add alpha, then encode fixed 4x4.
 */
export async function blurhashFromOriginal(bytes, { maxPixels = DEFAULT_MAX_SHARP_PIXELS } = {}) {
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes)) {
    throw new Error("original object must be bytes");
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new Error("maxPixels must be positive");

  const { data, info } = await sharp(bytes, {
    limitInputPixels: maxPixels,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: MAX_BLURHASH_AXIS,
      height: MAX_BLURHASH_AXIS,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4 || info.width < 1 || info.height < 1) {
    throw new Error("Sharp did not produce an RGBA raster");
  }
  if (info.width > MAX_BLURHASH_AXIS || info.height > MAX_BLURHASH_AXIS) {
    throw new Error("Sharp raster exceeds axis limit");
  }
  if (info.width * info.height > MAX_BLURHASH_PIXELS) {
    throw new Error("Sharp raster exceeds pixel limit");
  }

  const image = ensureMinimumRaster(new Uint8ClampedArray(data), info.width, info.height);
  return encodeBlurhash(
    image.pixels,
    image.width,
    image.height,
    BLURHASH_COMPONENTS,
    BLURHASH_COMPONENTS,
  );
}
