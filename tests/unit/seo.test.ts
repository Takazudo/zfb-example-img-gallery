import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readImageDimensions } from "../../lib/image-dims";
import {
  absoluteUrl,
  buildPageSeo,
  buildPhotoSeo,
  canonicalFor,
  metaDescription,
  pageTitle,
  toIso8601,
} from "../../lib/seo";
import { SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "../../lib/site";

const configuredGlobal = globalThis as { __zfb?: { site?: string } };

afterEach(() => {
  delete configuredGlobal.__zfb;
});

describe("canonical URL construction", () => {
  it("strips query/hash, normalises trailing slashes, and preserves the root slash", () => {
    expect(absoluteUrl("/photos/abc/?preview=1#crop", "https://gallery.example")).toBe(
      "https://gallery.example/photos/abc",
    );
    expect(absoluteUrl("/?preview=1", "https://gallery.example")).toBe("https://gallery.example/");
    expect(canonicalFor(
      new Request("https://foreign.example/photos/abc/?preview=1"),
      "https://gallery.example",
    )).toBe("https://gallery.example/photos/abc");
  });

  it("uses configured site identity despite a foreign request host", () => {
    configuredGlobal.__zfb = { site: "https://canonical.example/base" };
    const request = new Request("https://foreign.example/photos/7?preview=1");
    expect(siteOrigin(request)).toBe("https://canonical.example");
    expect(buildPageSeo({ request }).canonical).toBe("https://canonical.example/photos/7");
  });
});

describe("SEO text and dates", () => {
  it("composes a title once", () => {
    expect(pageTitle("  Quiet   lake ")).toBe(`Quiet lake | ${SITE_NAME}`);
    expect(pageTitle(`Quiet lake | ${SITE_NAME}`)).toBe(`Quiet lake | ${SITE_NAME}`);
    expect(pageTitle()).toBe(SITE_NAME);
  });

  it("collapses, truncates on a word boundary, and falls back", () => {
    expect(metaDescription("first\n  second", SITE_DESCRIPTION)).toBe("first second");
    const long = Array.from({ length: 40 }, () => "word").join(" ");
    const truncated = metaDescription(long, SITE_DESCRIPTION);
    expect(truncated.length).toBeLessThanOrEqual(160);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.at(-2)).not.toBe(" ");
    expect(metaDescription(" \n ", SITE_DESCRIPTION)).toBe(SITE_DESCRIPTION);
  });

  it("normalises supported dates and drops invalid values", () => {
    expect(toIso8601(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(toIso8601(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(toIso8601("2024-01-02T03:04:05+09:00")).toBe("2024-01-01T18:04:05.000Z");
    expect(toIso8601("2024-01-02 03:04:05")).toBe("2024-01-02T03:04:05.000Z");
    expect(toIso8601("garbage")).toBeUndefined();
  });
});

describe("photo SEO and committed brand assets", () => {
  it("builds absolute, script-safe ImageObject JSON-LD and omits absent optional keys", () => {
    configuredGlobal.__zfb = { site: "https://gallery.example" };
    const seo = buildPhotoSeo({
      request: new Request("https://foreign.example/anything?preview=1"),
      photo: {
        id: "7",
        title: "Night </script><scape",
        description: null,
        r2_key: "photos/original.jpg",
        thumb_key: null,
        width: 2000,
        height: 1500,
        content_type: "image/jpeg",
        created_at: "invalid",
      },
      authorUsername: "alice smith",
      tags: [],
    });
    expect(seo.canonical).toBe("https://gallery.example/photos/7");
    expect(seo.imageUrl).toBe("https://gallery.example/og/v1/7.jpg");
    expect(seo.jsonLd).not.toContain("<");
    const data = JSON.parse(seo.jsonLd!);
    expect(data.contentUrl).toBe("https://gallery.example/img/photos/original.jpg");
    expect(data.author).toEqual({
      "@type": "Person",
      name: "@alice smith",
      url: "https://gallery.example/authors/alice%20smith",
    });
    expect(data).not.toHaveProperty("thumbnailUrl");
    expect(data).not.toHaveProperty("uploadDate");
    expect(data).not.toHaveProperty("keywords");
  });

  it("commits the exact-size JPEG fallback and complete favicon set", async () => {
    const fallback = new Uint8Array(await readFile("public/og-fallback.jpg"));
    expect(readImageDimensions(fallback)).toEqual({ width: 1200, height: 630 });
    await Promise.all([
      "public/favicon.svg",
      "public/apple-touch-icon.png",
      "public/icon-192.png",
      "public/icon-512.png",
      "public/site.webmanifest",
    ].map((file) => access(file)));
  });
});
