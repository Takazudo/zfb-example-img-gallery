import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { createMockR2, webpVp8xFixture, type MockR2Bucket } from "../helpers/mock-r2";

const mocked = vi.hoisted(() => ({
  current: null as null | { env: Env; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocked.current,
}));

import ImgRoute from "../../pages/img/[...key]";

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const KEY = `photos/${UUID}.webp`;
let bucket: MockR2Bucket;

async function invoke(method = "GET", key: string | string[] = KEY, headers?: HeadersInit) {
  mocked.current = {
    env: { BUCKET: bucket } as unknown as Env,
    request: new Request(`https://example.test/img/${KEY}`, { method, headers }),
  };
  return ImgRoute({ params: { key } });
}

beforeEach(async () => {
  bucket = createMockR2();
  await bucket.put(KEY, webpVp8xFixture(20, 10), { httpMetadata: { contentType: "image/webp" } });
});

describe("image route", () => {
  it("serves a stored object from a string catch-all param", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webpVp8xFixture(20, 10));
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("content-length")).toBe(String(webpVp8xFixture(20, 10).byteLength));
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("etag")).toBe(`"mock-${KEY}"`);
  });

  it("serves HEAD from an array catch-all param with identical headers and no body", async () => {
    const response = await invoke("HEAD", ["photos", `${UUID}.webp`]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("etag")).toBe(`"mock-${KEY}"`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
    expect(bucket._headCalls).toEqual([KEY]);
    expect(bucket._getCalls).toEqual([]);
  });

  it("returns 404 without caching for a missing object", async () => {
    const missing = `photos/223e4567-e89b-12d3-a456-426614174000.webp`;
    const response = await invoke("GET", missing);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not found");
  });

  it("returns 405 and Allow for unsupported methods", async () => {
    const response = await invoke("POST");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects malformed keys before touching R2", async () => {
    const response = await invoke("GET", "photos/../secret.jpg");
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Bad request");
    expect(bucket._getCalls).toEqual([]);
    expect(bucket._headCalls).toEqual([]);
  });

  it("returns 304 for matching strong, weak, list, and wildcard validators", async () => {
    for (const value of [`"mock-${KEY}"`, `W/"mock-${KEY}"`, `"other", W/"mock-${KEY}"`, "*"]) {
      const response = await invoke("GET", KEY, { "if-none-match": value });
      expect(response.status).toBe(304);
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(response.headers.get("etag")).toBe(`"mock-${KEY}"`);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    }
  });

  it("returns the object for a non-matching validator", async () => {
    expect((await invoke("GET", KEY, { "if-none-match": '"different"' })).status).toBe(200);
  });
});
