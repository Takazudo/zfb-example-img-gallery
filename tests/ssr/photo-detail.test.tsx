import { runWithCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { OG_GENERATION } from "../../lib/og";
import PhotoDetailPage from "../../pages/photos/[id]";

const configuredGlobal = globalThis as { __zfb?: { site?: string } };

const photoRow = {
  id: 42,
  user_id: 7,
  title: "A quiet lake",
  description: "**not bold**\nsecond line <script>alert(1)</script>",
  r2_key: "photos/lake.webp",
  thumb_key: null,
  content_type: "image/webp",
  width: 2400,
  height: 1600,
  blurhash: null as string | null,
  created_at: "2026-08-20 01:02:03",
  author_id: 7,
  author_username: "alice",
  author_avatar_key: null,
};

function mockEnv(row = photoRow): Env {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => row),
      all: vi.fn(async () => ({
        results: sql.includes("FROM photo_tags")
          ? [{ id: 1, name: "landscape" }, { id: 2, name: "東京 scene" }]
          : [],
      })),
    };
    return statement;
  });
  return Object.assign(Object.create(null), { DB: { prepare } }) as Env;
}

function invoke(env: Env): Promise<Response> {
  return runWithCloudflareContext(
    {
      env,
      ctx: { waitUntil() {}, passThroughOnException() {} },
      request: new Request("https://request.example/photos/42?preview=1"),
    },
    () => PhotoDetailPage({ params: { id: "42" } }),
  );
}

function attribute(html: string, selector: RegExp, name: string): string | undefined {
  const tag = html.match(selector)?.[0];
  return tag?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

beforeEach(() => {
  configuredGlobal.__zfb = { site: "https://gallery.example" };
});

afterEach(() => {
  delete configuredGlobal.__zfb;
});

describe("photo detail SSR", () => {
  it("renders the detail placeholder with contain fit and no pending no-JS state", async () => {
    const html = await (await invoke(mockEnv({
      ...photoRow,
      blurhash: "Ub86Xpt:fQt:t:o#fQo#fQfQfQfQt:o#fQo#",
    }))).text();
    expect(html).toContain('data-image-placeholder="true"');
    expect(html).toContain('data-placeholder-fit="contain"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("data-placeholder-pending");
  });

  it("renders escaped plain text, author, encoded tags, and the uncropped hero", async () => {
    const html = await (await invoke(mockEnv())).text();

    expect(html).toContain('<a href="/authors/alice"');
    expect(html).toContain("@alice</a>");
    expect(html).toContain("**not bold**\nsecond line &lt;script>alert(1)&lt;/script>");
    expect(html).not.toContain("<strong>not bold</strong>");
    expect(html).not.toContain("<br");
    expect(html).toMatch(/<p class="[^"]*whitespace-pre-wrap[^"]*">/);
    expect(html).not.toContain("<script>alert(1)</script>");

    expect(html).toContain('<a href="/tags/landscape"');
    expect(html).toContain("#landscape</a>");
    expect(html).toContain('<a href="/tags/%E6%9D%B1%E4%BA%AC%20scene"');
    expect(html).not.toContain("%25E6%259D%25B1");

    const image = html.match(/<img src="\/img\/photos\/lake\.webp"[^>]*>/)?.[0];
    expect(image).toBeDefined();
    expect(image).toContain('alt="A quiet lake"');
    expect(image).toContain('width="2400"');
    expect(image).toContain('height="1600"');
    expect(image).toContain("object-contain");
    expect(image).toContain('fetchpriority="high"');
    expect(image).not.toContain('loading="lazy"');

    expect(html).toMatch(/data-testid="photo-detail" class="[^"]*md:grid-cols-\[1fr_20rem\]/);
    expect(html).toMatch(/data-testid="photo-detail-media" class="[^"]*min-w-0/);
  });

  it("renders the complete absolute social metadata contract", async () => {
    const html = await (await invoke(mockEnv())).text();
    const canonical = attribute(html, /<link rel="canonical"[^>]*>/, "href");
    const ogUrl = attribute(html, /<meta property="og:url"[^>]*>/, "content");
    const ogImage = attribute(html, /<meta property="og:image"[^>]*>/, "content");
    const author = attribute(html, /<meta property="article:author"[^>]*>/, "content");
    const published = attribute(
      html,
      /<meta property="article:published_time"[^>]*>/,
      "content",
    );

    expect(canonical).toBe("https://gallery.example/photos/42");
    expect(ogUrl).toBe(canonical);
    expect(ogImage).toBe(`https://gallery.example/og/${OG_GENERATION}/42.jpg`);
    expect(author).toBe("https://gallery.example/authors/alice");
    expect(attribute(html, /<meta property="og:image:width"[^>]*>/, "content")).toBe("1200");
    expect(attribute(html, /<meta property="og:image:height"[^>]*>/, "content")).toBe("630");
    expect(attribute(html, /<meta property="og:image:type"[^>]*>/, "content")).toBe("image/jpeg");
    expect(attribute(html, /<meta property="og:image:alt"[^>]*>/, "content")).toBe("A quiet lake");
    expect(attribute(html, /<meta property="og:type"[^>]*>/, "content")).toBe("article");
    expect(attribute(html, /<meta name="twitter:card"[^>]*>/, "content")).toBe("summary_large_image");
    expect(attribute(html, /<meta name="twitter:image"[^>]*>/, "content")).toBe(ogImage);
    expect(new Date(published ?? "invalid").toISOString()).toBe(published);
    expect(html).not.toContain("twitter:creator");
    expect(html).not.toContain("twitter:title");
    expect(html).not.toContain("twitter:description");
  });

  it("routes the detail og:image through the current OG generation", async () => {
    const html = await (await invoke(mockEnv())).text();
    const ogImage = attribute(html, /<meta property="og:image"[^>]*>/, "content");

    expect(ogImage).toBe(`https://gallery.example/og/${OG_GENERATION}/42.jpg`);
  });

  it("emits one parseable, script-safe ImageObject without a null thumbnail", async () => {
    const html = await (await invoke(mockEnv())).text();
    const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    const body = scripts[0]?.[1];
    expect(body).not.toContain("<");
    const json = JSON.parse(body ?? "");

    expect(json).toMatchObject({
      "@type": "ImageObject",
      name: "A quiet lake",
      contentUrl: "https://gallery.example/img/photos/lake.webp",
      width: 2400,
      height: 1600,
      uploadDate: "2026-08-20T01:02:03.000Z",
      author: { name: "@alice" },
    });
    expect(json).not.toHaveProperty("thumbnailUrl");
  });
});
