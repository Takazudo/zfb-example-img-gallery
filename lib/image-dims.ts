export interface ImageDims {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matches(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function valid(width: number, height: number): ImageDims | null {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function readPng(bytes: Uint8Array): ImageDims | null {
  if (
    bytes.length < 24 ||
    !matches(bytes, 0, PNG_SIGNATURE) ||
    !matches(bytes, 12, [0x49, 0x48, 0x44, 0x52])
  ) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return valid(view.getUint32(16), view.getUint32(20));
}

function isStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpeg(bytes: Uint8Array): ImageDims | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) return null;

    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7) return null;
      return valid(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }

  return null;
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readWebp(bytes: Uint8Array): ImageDims | null {
  if (
    bytes.length < 20 ||
    !matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) ||
    !matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkSize = view.getUint32(16, true);
  const payload = 20;
  if (chunkSize > bytes.length - payload) return null;

  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x20])) {
    if (chunkSize < 10 || !matches(bytes, payload + 3, [0x9d, 0x01, 0x2a])) return null;
    return valid(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff);
  }

  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x4c])) {
    if (chunkSize < 5 || bytes[payload] !== 0x2f) return null;
    const bits = view.getUint32(payload + 1, true);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }

  if (matches(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    if (chunkSize < 10) return null;
    return valid(readUint24LE(bytes, payload + 4) + 1, readUint24LE(bytes, payload + 7) + 1);
  }

  return null;
}

/** Returns null for unknown formats, truncated input, or non-positive dimensions. */
export function readImageDimensions(bytes: Uint8Array): ImageDims | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}
