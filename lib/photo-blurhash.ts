import { encode as encodeBlurhash } from "blurhash";
import { decode as decodePng } from "fast-png";
import { Unzlib } from "fflate";
import type { Env } from "./env";

export const BLURHASH_COMPONENTS = 4;
export const MAX_BLURHASH_AXIS = 32;
export const MAX_BLURHASH_PIXELS = MAX_BLURHASH_AXIS * MAX_BLURHASH_AXIS;
export const MAX_TRANSFORMED_PNG_BYTES = 64 * 1024;

type BlurhashStage = "transform" | "buffer" | "decode" | "normalise" | "encode";

function freshByteStream(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("invalid transformed chunk");
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("transformed PNG exceeds byte limit");
        throw new Error("transformed PNG exceeds byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

type PngContract = {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_CHANNELS = new Map<number, PngContract["channels"]>([
  [0, 1],
  [2, 3],
  [4, 2],
  [6, 4],
]);

function inspectPngContract(bytes: Uint8Array): PngContract {
  if (bytes.byteLength < 33) throw new Error("truncated PNG");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new Error("invalid PNG signature");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52
  ) {
    throw new Error("invalid PNG IHDR");
  }

  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0) throw new Error("zero PNG dimension");
  if (width > MAX_BLURHASH_AXIS || height > MAX_BLURHASH_AXIS) {
    throw new Error("PNG dimension exceeds limit");
  }
  if (width * height > MAX_BLURHASH_PIXELS) throw new Error("PNG pixel count exceeds limit");
  if (bytes[24] !== 8) throw new Error("unsupported PNG bit depth");

  const channels = PNG_CHANNELS.get(bytes[25]);
  if (channels === undefined) throw new Error("unsupported PNG colour type");
  if (bytes[26] !== 0 || bytes[27] !== 0) throw new Error("unsupported PNG compression or filter");
  if (bytes[28] !== 0) throw new Error("unsupported interlaced PNG");
  return { width, height, channels };
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/**
 * Inflate once with a strict output budget before handing data to fast-png.
 * This prevents a small, malicious IDAT stream from expanding without bound.
 */
function verifyPngDataBudget(bytes: Uint8Array, contract: PngContract): void {
  const expectedBytes = contract.height * (1 + contract.width * contract.channels);
  let inflatedBytes = 0;
  const inflater = new Unzlib((chunk) => {
    inflatedBytes += chunk.byteLength;
    if (inflatedBytes > expectedBytes) throw new Error("inflated PNG data exceeds pixel budget");
  });

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawIdat = false;
  let idatEnded = false;
  let sawIend = false;

  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) throw new Error("truncated PNG chunk");
    const length = view.getUint32(offset);
    if (length > bytes.byteLength - offset - 12) throw new Error("PNG chunk exceeds encoded data");
    const typeOffset = offset + 4;
    const type = chunkType(bytes, typeOffset);
    const dataOffset = offset + 8;

    if (offset === 8 && type !== "IHDR") throw new Error("PNG IHDR is not first");
    if (offset !== 8 && type === "IHDR") throw new Error("duplicate PNG IHDR");
    if (type === "iCCP") throw new Error("embedded PNG profile is unsupported");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("animated PNG is unsupported");
    }

    if (type === "IDAT") {
      if (idatEnded) throw new Error("non-consecutive PNG IDAT chunks");
      sawIdat = true;
      inflater.push(bytes.subarray(dataOffset, dataOffset + length), false);
    } else if (sawIdat) {
      idatEnded = true;
    }

    if (type === "IEND") {
      if (length !== 0) throw new Error("invalid PNG IEND");
      sawIend = true;
      offset += 12;
      break;
    }

    // Reject unknown critical chunks. Ancillary chunks are encoded-size bounded
    // and fast-png either safely reads or skips them (iCCP is rejected above).
    if (type !== "IHDR" && type !== "IDAT" && type.charCodeAt(0) <= 0x5a) {
      throw new Error("unsupported critical PNG chunk");
    }
    offset += length + 12;
  }

  if (!sawIdat || !sawIend || offset !== bytes.byteLength) throw new Error("incomplete PNG chunk sequence");
  inflater.push(new Uint8Array(0), true);
  if (inflatedBytes !== expectedBytes) throw new Error("inflated PNG data is inconsistent");
}

export function decodeTransformedPng(
  bytes: Uint8Array,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const contract = inspectPngContract(bytes);
  verifyPngDataBudget(bytes, contract);
  const decoded = decodePng(bytes, { checkCrc: true });
  if (
    decoded.width !== contract.width ||
    decoded.height !== contract.height ||
    decoded.depth !== 8 ||
    decoded.channels !== contract.channels
  ) {
    throw new Error("decoded PNG metadata is inconsistent");
  }

  const expectedLength = contract.width * contract.height * contract.channels;
  if (decoded.data.BYTES_PER_ELEMENT !== 1 || decoded.data.length !== expectedLength) {
    throw new Error("decoded PNG channel data is inconsistent");
  }

  const transparency = decoded.transparency;
  if (transparency !== undefined) {
    const expected = contract.channels === 1 ? 1 : contract.channels === 3 ? 3 : 0;
    if (transparency.length !== expected) throw new Error("invalid PNG transparency data");
  }

  const rgba = new Uint8ClampedArray(contract.width * contract.height * 4);
  for (let pixel = 0; pixel < contract.width * contract.height; pixel += 1) {
    const source = pixel * contract.channels;
    const target = pixel * 4;
    if (contract.channels === 1) {
      const grey = decoded.data[source];
      rgba[target] = grey;
      rgba[target + 1] = grey;
      rgba[target + 2] = grey;
      rgba[target + 3] = transparency?.[0] === grey ? 0 : 255;
    } else if (contract.channels === 2) {
      const grey = decoded.data[source];
      rgba[target] = grey;
      rgba[target + 1] = grey;
      rgba[target + 2] = grey;
      rgba[target + 3] = decoded.data[source + 1];
    } else {
      const red = decoded.data[source];
      const green = decoded.data[source + 1];
      const blue = decoded.data[source + 2];
      rgba[target] = red;
      rgba[target + 1] = green;
      rgba[target + 2] = blue;
      rgba[target + 3] = contract.channels === 4
        ? decoded.data[source + 3]
        : transparency?.[0] === red && transparency[1] === green && transparency[2] === blue
          ? 0
          : 255;
    }
  }
  return { pixels: rgba, width: contract.width, height: contract.height };
}

function ensureMinimumAxes(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const targetWidth = Math.max(BLURHASH_COMPONENTS, width);
  const targetHeight = Math.max(BLURHASH_COMPONENTS, height);
  if (targetWidth === width && targetHeight === height) return { pixels, width, height };

  const resized = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(y * height / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x * width / targetWidth));
      const source = (sourceY * width + sourceX) * 4;
      resized.set(pixels.subarray(source, source + 4), (y * targetWidth + x) * 4);
    }
  }
  return { pixels: resized, width: targetWidth, height: targetHeight };
}

/** Decode a bounded transform result and produce a fixed-4x4 BlurHash. */
export function blurhashFromTransformedPng(png: Uint8Array): string {
  const decoded = decodeTransformedPng(png);
  const image = ensureMinimumAxes(decoded.pixels, decoded.width, decoded.height);
  return encodeBlurhash(
    image.pixels,
    image.width,
    image.height,
    BLURHASH_COMPONENTS,
    BLURHASH_COMPONENTS,
  );
}

/** Best-effort wrapper used by photo ingestion; it never exposes upload data in logs. */
export async function tryGeneratePhotoBlurhash(env: Env, originalBytes: ArrayBuffer): Promise<string | null> {
  let stage: BlurhashStage = "transform";
  try {
    const transformed = await env.IMAGES.input(freshByteStream(originalBytes))
      .transform({ fit: "scale-down", width: MAX_BLURHASH_AXIS, height: MAX_BLURHASH_AXIS })
      .output({ format: "image/png" });
    stage = "buffer";
    const png = await readBounded(transformed.image(), MAX_TRANSFORMED_PNG_BYTES);
    stage = "decode";
    const decoded = decodeTransformedPng(png);
    stage = "normalise";
    const image = ensureMinimumAxes(decoded.pixels, decoded.width, decoded.height);
    stage = "encode";
    return encodeBlurhash(
      image.pixels,
      image.width,
      image.height,
      BLURHASH_COMPONENTS,
      BLURHASH_COMPONENTS,
    );
  } catch (error) {
    console.warn({
      event: "photo_blurhash_generation_failed",
      stage,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}
