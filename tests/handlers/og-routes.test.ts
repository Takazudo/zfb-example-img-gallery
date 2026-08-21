import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { readImageDimensions } from "../../lib/image-dims";
import { OG_FALLBACK_CACHE, OG_IMMUTABLE_CACHE, ogObjectKey } from "../../lib/og";
import { createMockR2, jpegFixture, pngFixture, type MockR2Bucket } from "../helpers/mock-r2";

const mocked = vi.hoisted(() => ({
  current: null as null | { env: Env; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocked.current,
}));

import OgCardRoute from "../../pages/og/v1/[id]";
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

function mockImages(options: { fail?: boolean; bytes?: Uint8Array } = {}) {
  const output = vi.fn(async () => ({
    image: () => new Response((options.bytes ?? CARD).slice().buffer).body!,
  }));
  const transform = vi.fn(() => ({ output }));
  const input = vi.fn(() => {
    if (options.fail) throw new Error("images unavailable");
    return { transform };
  });
  const binding: ImagesBinding = Object.assign(Object.create(null), { input });
  return { binding, input, transform, output };
}

function assetsBinding() {
  const fetch = vi.fn(async () => new Response(FALLBACK.slice().buffer, {
    headers: { "content-type": "image/jpeg" },
  }));
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

async function invokeOg(env: Env, path = "/og/v1/7.jpg", method = "GET") {
  mocked.current = { env, request: new Request(`https://request.example${path}`, { method }) };
  return OgCardRoute();
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
    await bucket.put(ogObjectKey("7"), CARD, { httpMetadata: { contentType: "image/jpeg" } });
    const images = mockImages();
    const response = await invokeOg(makeEnv({ bucket, images: images.binding }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(OG_IMMUTABLE_CACHE);
    expect(response.headers.get("etag")).toBe(`"mock-${ogObjectKey("7")}"`);
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
    const stored = bucket._store.get(ogObjectKey("7"));
    expect(stored?.contentType).toBe("image/jpeg");
    expect(readImageDimensions(stored!.bytes)).toEqual({ width: 1200, height: 630 });
  });

  it("soft-recovers generation failure through Static Assets", async () => {
    const bucket = createMockR2();
    await bucket.put("photos/source.png", pngFixture(100, 100));
    const images = mockImages({ fail: true });
    const assets = assetsBinding();
    const response = await invokeOg(makeEnv({ bucket, images: images.binding, assets: assets.binding }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(OG_FALLBACK_CACHE);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FALLBACK);
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("returns a real 404 for an unknown photo", async () => {
    const response = await invokeOg(makeEnv({ db: mockDb({ photo: null }) }));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("supports HEAD and rejects invalid methods, suffixes, and ids", async () => {
    const bucket = createMockR2();
    await bucket.put(ogObjectKey("7"), CARD, { httpMetadata: { contentType: "image/jpeg" } });
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
