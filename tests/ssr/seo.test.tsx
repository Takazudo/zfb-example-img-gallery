import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { buildPhotoSeo } from "../../lib/seo";
import GalleryLayout from "../../layouts/gallery-layout";

const configuredGlobal = globalThis as { __zfb?: { site?: string } };

afterEach(() => {
  delete configuredGlobal.__zfb;
});

function renderPhotoHead(): string {
  configuredGlobal.__zfb = { site: "https://gallery.example" };
  const seo = buildPhotoSeo({
    request: new Request("https://foreign.example/photos/42?preview=1"),
    photo: {
      id: "42",
      title: "A <quiet> lake",
      description: "Blue water at dawn.",
      r2_key: "photos/42.jpg",
      thumb_key: "thumbs/42.jpg",
      width: 2400,
      height: 1600,
      content_type: "image/jpeg",
      created_at: "2026-08-20 01:02:03",
    },
    authorUsername: "alice",
    tags: ["lake", "dawn"],
  });
  return render(<GalleryLayout seo={seo}>Photo</GalleryLayout>);
}

describe("SEO head", () => {
  it("renders the complete social tag contract with absolute URLs and one title", () => {
    const html = renderPhotoHead();
    for (const marker of [
      'name="description"', 'rel="canonical"', 'property="og:title"',
      'property="og:description"', 'property="og:image"', 'property="og:image:width"',
      'property="og:image:height"', 'property="og:image:alt"', 'property="og:image:type"',
      'property="og:type"', 'property="article:published_time"', 'property="article:author"',
      'property="og:url"', 'property="og:site_name"', 'property="og:locale"',
      'name="twitter:card"', 'name="twitter:site"', 'name="twitter:image"',
      'name="twitter:image:alt"', 'type="application/ld+json"',
    ]) expect(html).toContain(marker);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('href="https://gallery.example/photos/42"');
    expect(html).toContain('content="https://gallery.example/og/v1/42.jpg"');
    expect(html).toContain('content="https://gallery.example/authors/alice"');
    expect(html).not.toContain("twitter:creator");
    expect(html).not.toContain("twitter:title");
    expect(html).not.toContain("twitter:description");
    const ogImage = html.match(/property="og:image" content="([^"]+)"/)?.[1];
    const twitterImage = html.match(/name="twitter:image" content="([^"]+)"/)?.[1];
    expect(twitterImage).toBe(ogImage);
  });

  it("emits parseable, script-safe ImageObject JSON-LD", () => {
    const html = renderPhotoHead();
    const body = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(body).toBeDefined();
    expect(body).not.toContain("</script>");
    expect(body).not.toContain("<");
    const data = JSON.parse(body!);
    expect(data["@type"]).toBe("ImageObject");
    expect(data.contentUrl).toBe("https://gallery.example/img/photos/42.jpg");
    expect(data.thumbnailUrl).toBe("https://gallery.example/img/thumbs/42.jpg");
    expect(data.author).toEqual({
      "@type": "Person",
      name: "@alice",
      url: "https://gallery.example/authors/alice",
    });
  });
});
