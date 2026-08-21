export interface MockR2Bucket extends R2Bucket {
  _store: Map<string, { bytes: Uint8Array; contentType: string; etag: string }>;
  _deleteBatchSizes: number[];
  _getCalls: string[];
  _headCalls: string[];
}

function copyBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

async function bodyBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return copyBytes(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value === null) return new Uint8Array();
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
}

function r2Object(
  key: string,
  entry: { bytes: Uint8Array; contentType: string; etag: string },
  withBody: boolean,
): R2Object | R2ObjectBody {
  const base = {
    key,
    version: "1",
    size: entry.bytes.byteLength,
    etag: entry.etag.replaceAll('"', ""),
    httpEtag: entry.etag,
    checksums: { toJSON: () => ({}) },
    uploaded: new Date(0),
    httpMetadata: { contentType: entry.contentType },
    storageClass: "Standard",
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", entry.contentType);
    },
  };
  if (!withBody) return base as R2Object;
  const bytes = entry.bytes.slice();
  return {
    ...base,
    body: new Response(bytes).body!,
    bodyUsed: false,
    arrayBuffer: async () => bytes.slice().buffer,
    bytes: async () => bytes.slice(),
    text: async () => new TextDecoder().decode(bytes),
    json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    blob: async () => new Blob([bytes]),
  } as R2ObjectBody;
}

export function createMockR2(): MockR2Bucket {
  const store = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  const deleteBatchSizes: number[] = [];
  const getCalls: string[] = [];
  const headCalls: string[] = [];

  const bucket = {
    async put(key: string, value: unknown, options?: R2PutOptions) {
      const bytes = await bodyBytes(value);
      const metadata = options?.httpMetadata;
      const contentType = metadata instanceof Headers
        ? (metadata.get("content-type") ?? "")
        : (metadata?.contentType ?? "");
      const entry = { bytes, contentType, etag: `"mock-${key}"` };
      store.set(key, entry);
      return r2Object(key, entry, false);
    },
    async get(key: string) {
      getCalls.push(key);
      const entry = store.get(key);
      return entry ? r2Object(key, entry, true) : null;
    },
    async head(key: string) {
      headCalls.push(key);
      const entry = store.get(key);
      return entry ? r2Object(key, entry, false) : null;
    },
    async delete(keys: string | string[]) {
      const batch = Array.isArray(keys) ? keys : [keys];
      deleteBatchSizes.push(batch.length);
      for (const key of batch) store.delete(key);
    },
    async list(options: R2ListOptions = {}) {
      const matching = [...store.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
      if (options.delimiter) {
        const prefixes = new Set<string>();
        for (const key of matching) {
          const rest = key.slice((options.prefix ?? "").length);
          const delimiterAt = rest.indexOf(options.delimiter);
          if (delimiterAt >= 0) prefixes.add((options.prefix ?? "") + rest.slice(0, delimiterAt + 1));
        }
        return { objects: [], delimitedPrefixes: [...prefixes], truncated: false as const };
      }
      return {
        objects: matching.map((key) => r2Object(key, store.get(key)!, false)),
        delimitedPrefixes: [],
        truncated: false as const,
      };
    },
    _store: store,
    _deleteBatchSizes: deleteBatchSizes,
    _getCalls: getCalls,
    _headCalls: headCalls,
  };
  return bucket as unknown as MockR2Bucket;
}

export function pngFixture(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export function jpegFixture(width: number, height: number, marker = 0xc0, app1 = false): Uint8Array {
  const prefix = app1 ? [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00] : [];
  return new Uint8Array([
    0xff, 0xd8, ...prefix,
    0xff, marker, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

function webpFixture(fourcc: number[], payload: number[]): Uint8Array {
  const bytes = new Uint8Array(20 + payload.length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set(fourcc, 12);
  new DataView(bytes.buffer).setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

export function webpVp8Fixture(width: number, height: number): Uint8Array {
  return webpFixture([0x56, 0x50, 0x38, 0x20], [
    0, 0, 0, 0x9d, 0x01, 0x2a,
    width & 0xff, width >> 8, height & 0xff, height >> 8,
  ]);
}

export function webpVp8lFixture(width: number, height: number): Uint8Array {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webpFixture([0x56, 0x50, 0x38, 0x4c], [
    0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff,
  ]);
}

export function webpVp8xFixture(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return webpFixture([0x56, 0x50, 0x38, 0x58], [
    0, 0, 0, 0,
    w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff,
    h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff,
  ]);
}
