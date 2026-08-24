import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { readImageDimensions } from "../../lib/image-dims";
import { BOX, SHADOW_BOX, SHADOW_OPACITY } from "../../lib/og-card-layout.mjs";
import { OG_FALLBACK_CACHE, OG_IMMUTABLE_CACHE, ogObjectKey } from "../../lib/og";
import { createMockR2, jpegFixture, pngFixture, type MockR2Bucket } from "../helpers/mock-r2";

const mocked = vi.hoisted(() => ({
  current: null as null | { env: Env; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocked.current,
}));

import OgV1CardRoute from "../../pages/og/v1/[id]";
import OgV2CardRoute from "../../pages/og/v2/[id]";
import RobotsRoute from "../../pages/robots.txt";
import SitemapRoute from "../../pages/sitemap.xml";

const configuredGlobal = globalThis as { __zfb?: { site?: string } };
const CARD = jpegFixture(1200, 630);
const FALLBACK = jpegFixture(1200, 630, 0xc2, true);

type DataSet = {
  photo?: { id: string; r2_key: string } | null;
  photos?: Array<{ id: string; created_at: string }>;
  authors?: Array<{ username: string }>;
  tags?: Array<{ name: string }>;
};

function mockDb(data: DataSet): D1Database {
  return {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        first: async () => data.photo ?? null,
        all: async () => {
          if (sql.includes("FROM photos ORDER BY")) return { results: data.photos ?? [] };
          if (sql.includes("SELECT DISTINCT u.username")) return { results: data.authors ?? [] };
          if (sql.includes("SELECT DISTINCT t.name")) return { results: data.tags ?? [] };
          return { results: [] };
        },
      };
      return statement;
    },
  } as D1Database;
}

function mockImages(options: { fail?: boolean; failComposite?: boolean; bytes?: Uint8Array } = {}) {
  const events: Array<{
    type: "draw" | "transform" | "output";
    transformer: number;
    argument?: unknown;
    image?: number;
  }> = [];
  const streams: ReadableStream<Uint8Array>[] = [];
  const transformerIds = new WeakMap<object, number>();
  const transform = vi.fn();
  const draw = vi.fn();
  const output = vi.fn();
  const input = vi.fn((stream: ReadableStream<Uint8Array>) => {
    if (options.fail) throw new Error("images unavailable");
    const id = streams.length;
    streams.push(stream);
    const transformer: ImageTransformer = {
      transform(argument: ImageTransform) {
        transform(argument);
        events.push({ type: "transform", transformer: id, argument });
        return transformer;
      },
      draw(image: ReadableStream<Uint8Array> | ImageTransformer, argument?: ImageDrawOptions) {
        draw(image, argument);
        events.push({
          type: "draw",
          transformer: id,
          argument,
          image: typeof image === "object" ? transformerIds.get(image) : undefined,
        });
        if (options.failComposite && argument?.left === SHADOW_BOX.x) {
          throw new Error("draw unavailable");
        }
        return transformer;
      },
      async output(argument: ImageOutputOptions): Promise<ImageTransformationResult> {
        output(argument);
        events.push({ type: "output", transformer: id, argument });
        const bytes = options.bytes ?? CARD;
        const response = (responseOptions?: ImageTransformationResponseOptions) => new Response(
          bytes.slice().buffer as ArrayBuffer,
          { headers: responseOptions?.headers },
        );
        return {
          image: () => response().body!,
          response,
          contentType: () => "image/jpeg",
        };
      },
    };
    transformerIds.set(transformer, id);
    return transformer;
  });
  const binding: ImagesBinding = Object.assign(Object.create(null), { input });
  return { binding, draw, events, input, output, streams, transform };
}

function assetsBinding() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/og-fallback.jpg") {
      return new Response(FALLBACK.slice().buffer, { headers: { "content-type": "image/jpeg" } });
    }
    return new Response(
      (pathname === "/og-plate.png" ? pngFixture(1200, 630) : pngFixture(1, 1)).slice().buffer as ArrayBuffer,
      { headers: { "content-type": "image/png" } },
    );
  });
  const binding: Fetcher = Object.assign(Object.create(null), { fetch });
  return { binding, fetch };
}

function makeEnv(input: {
  bucket?: MockR2Bucket;
  db?: D1Database;
  images?: ImagesBinding;
  assets?: Fetcher;
} = {}): Env {
  return Object.assign(Object.create(null), {
    DB: input.db ?? mockDb({ photo: { id: "7", r2_key: "photos/source.png" } }),
    BUCKET: input.bucket ?? createMockR2(),
    IMAGES: input.images ?? mockImages().binding,
    ASSETS: input.assets ?? assetsBinding().binding,
  });
}

type OgRoute = () => Promise<Response>;

async function invokeOg(
  env: Env,
  path = "/og/v1/7.jpg",
  method = "GET",
  route: OgRoute = OgV1CardRoute,
) {
  mocked.current = { env, request: new Request(`https://request.example${path}`, { method }) };
  return route();
}

beforeEach(() => {
  configuredGlobal.__zfb = { site: "https://gallery.example" };
});

afterEach(() => {
  delete configuredGlobal.__zfb;
});

describe("OG image route", () => {
  it("serves an immutable cache hit without invoking Images", async () => {
    const bucket = createMockR2();
    await bucket.put(ogObjectKey("7", "v1"), CARD, { httpMetadata: { contentType: "image/jpeg" } });
    const images = mockImages();
    const response = await invokeOg(makeEnv({ bucket, images: images.binding }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(OG_IMMUTABLE_CACHE);
    expect(response.headers.get("etag")).toBe(`"mock-${ogObjectKey("7", "v1")}"`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(CARD);
    expect(images.input).not.toHaveBeenCalled();
  });

  it("cover-crops a miss and persists an exact 1200x630 JPEG", async () => {
    const bucket = createMockR2();
    await bucket.put("photos/source.png", pngFixture(800, 800), {
      httpMetadata: { contentType: "image/png" },
    });
    const images = mockImages();
    const response = await invokeOg(makeEnv({ bucket, images: images.binding }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(images.transform).toHaveBeenCalledWith({
      width: 1200,
      height: 630,
      fit: "cover",
      gravity: "auto",
    });
    expect(images.output).toHaveBeenCalledWith({ format: "image/jpeg", quality: 85 });
    const stored = bucket._store.get(ogObjectKey("7", "v1"));
    expect(stored?.contentType).toBe("image/jpeg");
    expect(readImageDimensions(stored!.bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("pins v1 and v2 routes to their own stored generation", async () => {
    const bucket = createMockR2();
    const v1Card = jpegFixture(1200, 630, 0xc0);
    const v2Card = jpegFixture(1200, 630, 0xc1);
    await bucket.put(ogObjectKey("7", "v1"), v1Card, { httpMetadata: { contentType: "image/jpeg" } });
    await bucket.put(ogObjectKey("7", "v2"), v2Card, { httpMetadata: { contentType: "image/jpeg" } });
    const images = mockImages();
    const env = makeEnv({ bucket, images: images.binding });

    const v1Response = await invokeOg(env, "/og/v1/7.jpg");
    const v2Response = await invokeOg(env, "/og/v2/7.jpg", "GET", OgV2CardRoute);

    expect(new Uint8Array(await v1Response.arrayBuffer())).toEqual(v1Card);
    expect(new Uint8Array(await v2Response.arrayBuffer())).toEqual(v2Card);
    expect(images.input).not.toHaveBeenCalled();
  });

  it("composes, persists, and reuses a v2 miss with the required draw order", async () => {
    const bucket = createMockR2();
    await bucket.put("photos/source.png", pngFixture(800, 800), {
      httpMetadata: { contentType: "image/png" },
    });
    const images = mockImages();
    const env = makeEnv({ bucket, images: images.binding });
    const response = await invokeOg(env, "/og/v2/7.jpg", "GET", OgV2CardRoute);
    const cached = await invokeOg(env, "/og/v2/7.jpg", "GET", OgV2CardRoute);

    expect(response.status).toBe(200);
    expect(cached.status).toBe(200);
    expect(bucket._store.get(ogObjectKey("7", "v2"))?.contentType).toBe("image/jpeg");
    expect(bucket._store.has(ogObjectKey("7", "v1"))).toBe(false);
    expect(images.input).toHaveBeenCalledTimes(4);
    expect(new Set(images.streams).size).toBe(4);
    const inputDimensions = await Promise.all(images.streams.map(async (stream) => (
      readImageDimensions(new Uint8Array(await new Response(stream).arrayBuffer()))
    )));
    expect(inputDimensions).toEqual([
      { width: 800, height: 800 },
      { width: 800, height: 800 },
      { width: 1, height: 1 },
      { width: 1200, height: 630 },
    ]);
    expect(images.events.filter((event) => event.type === "draw")).toEqual([
      { type: "draw", transformer: 1, image: 2, argument: { composite: "in", repeat: true } },
      {
        type: "draw",
        transformer: 3,
        image: 1,
        argument: { left: SHADOW_BOX.x, top: SHADOW_BOX.y, opacity: SHADOW_OPACITY },
      },
      { type: "draw", transformer: 3, image: 0, argument: { left: BOX.x, top: BOX.y } },
    ]);
    expect(images.output).toHaveBeenLastCalledWith({ format: "image/jpeg", quality: 88 });
  });

  it("degrades a composite-only v2 failure to a persisted cover card", async () => {
    const bucket = createMockR2();
    await bucket.put("photos/source.png", pngFixture(100, 100));
    const images = mockImages({ failComposite: true });
    const assets = assetsBinding();
    const response = await invokeOg(
      makeEnv({ bucket, images: images.binding, assets: assets.binding }),
      "/og/v2/7.jpg",
      "GET",
      OgV2CardRoute,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(OG_IMMUTABLE_CACHE);
    expect(images.input).toHaveBeenCalledTimes(5);
    expect(images.transform).toHaveBeenLastCalledWith({
      width: 1200,
      height: 630,
      fit: "cover",
      gravity: "auto",
    });
    expect(images.output).toHaveBeenLastCalledWith({ format: "image/jpeg", quality: 85 });
    expect(bucket._store.has(ogObjectKey("7", "v2"))).toBe(true);
    expect(assets.fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === "/og-fallback.jpg")).toBe(false);
  });

  it("soft-recovers total v2 binding failure through Static Assets", async () => {
    const bucket = createMockR2();
    await bucket.put("photos/source.png", pngFixture(100, 100));
    const images = mockImages({ fail: true });
    const assets = assetsBinding();
    const response = await invokeOg(
      makeEnv({ bucket, images: images.binding, assets: assets.binding }),
      "/og/v2/7.jpg",
      "GET",
      OgV2CardRoute,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(OG_FALLBACK_CACHE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FALLBACK);
    expect(assets.fetch).toHaveBeenCalledOnce();
    expect(bucket._store.has(ogObjectKey("7", "v2"))).toBe(false);
  });

  it("returns a real 404 for an unknown photo", async () => {
    const response = await invokeOg(makeEnv({ db: mockDb({ photo: null }) }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("supports HEAD and rejects invalid methods, suffixes, and ids", async () => {
    const bucket = createMockR2();
    await bucket.put(ogObjectKey("7", "v1"), CARD, { httpMetadata: { contentType: "image/jpeg" } });
    const env = makeEnv({ bucket });
    const head = await invokeOg(env, "/og/v1/7.jpg", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe(OG_IMMUTABLE_CACHE);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const post = await invokeOg(env, "/og/v1/7.jpg", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await invokeOg(env, "/og/v1/7")).status).toBe(404);
    expect((await invokeOg(env, "/og/v1/bad%20id.jpg")).status).toBe(404);
  });
});

describe("crawler routes", () => {
  it("serves robots.txt with private routes disallowed and an absolute sitemap", async () => {
    const env = makeEnv();
    mocked.current = { env, request: new Request("https://foreign.example/robots.txt") };
    const response = await RobotsRoute();
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/plain");
    for (const path of ["/settings", "/upload", "/login", "/logout", "/register"]) {
      expect(body).toContain(`Disallow: ${path}`);
    }
    expect(body).toContain("Sitemap: https://gallery.example/sitemap.xml");
  });

  it("serves a canonical, escaped sitemap for every collection", async () => {
    const db = mockDb({
      photos: [
        { id: "7", created_at: "2026-08-20 01:02:03" },
        { id: "8", created_at: "invalid" },
      ],
      authors: [{ username: "O'Neil" }],
      tags: [{ name: "rock & roll" }],
    });
    const env = makeEnv({ db });
    mocked.current = { env, request: new Request("https://foreign.example/sitemap.xml?x=1") };
    const response = await SitemapRoute();
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("application/xml");
    for (const loc of [
      "https://gallery.example/",
      "https://gallery.example/authors",
      "https://gallery.example/tags",
      "https://gallery.example/photos/7",
      "https://gallery.example/photos/8",
      "https://gallery.example/tags/rock%20%26%20roll",
    ]) expect(body).toContain(`<loc>${loc}</loc>`);
    expect(body).toContain("https://gallery.example/authors/O&apos;Neil");
    expect(body).toContain("<lastmod>2026-08-20</lastmod>");
    expect(body.match(/<lastmod>/g)).toHaveLength(1);
    expect(body).not.toContain("?x=1");
  });
});
