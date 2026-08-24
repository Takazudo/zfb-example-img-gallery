import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Button } from "../../components/button";
import { EmptyState } from "../../components/empty-state";
import { Field } from "../../components/field";
import { PhotoCard } from "../../components/photo-card";
import { PhotoFeed } from "../../components/photo-feed";
import { PhotoGrid } from "../../components/photo-grid";
import { TagList } from "../../components/tag-list";
import GalleryLayout from "../../layouts/gallery-layout";
import { GALLERY_PREFERENCES_BOOTSTRAP_SCRIPT } from "../../lib/gallery-preferences";
import { THEME_BOOTSTRAP_SCRIPT } from "../../lib/theme";
import { DEFAULT_SNAPSHOT_LIMITS, utf8ByteLength } from "../../lib/gallery-snapshots";

const VALID_BLURHASH = "Ub86Xpt:fQt:t:o#fQo#fQfQfQfQt:o#fQo#";

describe("GalleryLayout", () => {
  it("renders the dynamic document head with one stable stylesheet and module entry", () => {
    const html = render(<GalleryLayout title="Gallery">content</GalleryLayout>);
    expect(html).toContain('<html lang="en"');
    expect(html).toMatch(/<meta char(?:s|S)et="utf-8"/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1"');
    expect(html).toContain("<title>Gallery — Stillframe</title>");
    expect(html.match(/href="\/assets\/app\.css"/g)).toHaveLength(1);
    expect(html.match(/<script type="module" src="\/assets\/islands\.js"><\/script>/g)).toHaveLength(1);
  });
  it("emits the marked pre-paint bootstrap before stylesheet work", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html).toContain(
      `<script data-theme-bootstrap="true">${THEME_BOOTSTRAP_SCRIPT}${GALLERY_PREFERENCES_BOOTSTRAP_SCRIPT}</script>`,
    );
    expect(html.indexOf("data-theme-bootstrap")).toBeLessThan(html.indexOf('href="/assets/app.css"'));
  });
  it("mounts the uniform SPA router policy and preserves its announcer styles", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html).toContain('name="zfb-view-transitions-enabled" content="true"');
    expect(html).toContain('name="zfb-view-transitions-fallback" content="animate"');
    expect(html).toContain(
      'name="zfb-preserve-html-attrs" content="data-theme data-thumb-ratio data-thumb-width"',
    );
    expect(html).toContain('name="zfb-traverse-refetch" content="true"');
    expect(html).toContain(".zfb-route-announcer");
  });
  it("mounts the stable accessible theme island in the wrapping header nav", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html).toContain('data-zfb-island="ThemeToggle"');
    expect(html).toContain('data-when="load"');
    expect(html).toContain('aria-label="Switch to dark mode"');
    expect(html).toMatch(/<nav[^>]*>[\s\S]*data-zfb-island="ThemeToggle"[\s\S]*<\/nav>/);
    expect(html).toContain("flex w-full flex-wrap items-center");
    const props = html.match(/data-zfb-island="ThemeToggle"[^>]*data-props="([^"]*)"/)?.[1];
    expect(props).toBeUndefined();
  });
  it("mounts one stable display-settings island for anonymous and signed-in headers", () => {
    for (const user of [null, { username: "takazudo" }]) {
      const html = render(<GalleryLayout user={user}>content</GalleryLayout>);
      expect(html.match(/data-zfb-island="DisplaySettings"/g)).toHaveLength(1);
      expect(html).toMatch(
        /<nav[^>]*>[\s\S]*data-zfb-island="DisplaySettings" data-when="load"[\s\S]*<\/nav>/,
      );
      expect(html).not.toContain('aria-haspopup="dialog"');
    }
  });
  it("mounts the zero-DOM infinite-feed controller in the existing island runtime", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html.match(/data-zfb-island="InfiniteGalleryControllerIsland"/g)).toHaveLength(1);
    expect(html).toContain('data-zfb-island="InfiniteGalleryControllerIsland" data-when="load"');
    expect(html.match(/src="\/assets\/islands\.js"/g)).toHaveLength(1);
  });
  it("suppresses only the manual stable module for the SSG document mode", () => {
    const html = render(<GalleryLayout includeStableClientEntry={false}>content</GalleryLayout>);
    expect(html).not.toContain('src="/assets/islands.js"');
    expect(html).toContain('data-zfb-island="ThemeToggle"');
    expect(html).toContain('data-zfb-island="DisplaySettings"');
    expect(html).toContain('name="zfb-view-transitions-enabled"');
  });
  it("renders signed-out controls only", () => {
    const html = render(<GalleryLayout user={null}>content</GalleryLayout>);
    expect(html).toContain('href="/login"'); expect(html).toContain('href="/register"');
    expect(html).not.toContain('href="/upload"'); expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain('action="/logout"');
  });
  it("renders signed-in controls and a POST logout form", () => {
    const html = render(<GalleryLayout user={{ username: "takazudo" }}>content</GalleryLayout>);
    expect(html).toContain("@takazudo"); expect(html).toContain('href="/authors/takazudo"');
    expect(html).toContain('href="/upload"'); expect(html).toContain('href="/settings"');
    expect(html).toContain('<form method="post" action="/logout">');
  });
  it("marks only the matching navigation link as current", () => {
    const html = render(<GalleryLayout activePath="/tags">content</GalleryLayout>);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/tags" aria-current="page"/);
  });
  it("contains only the intentional bootstrap and module scripts with no inline event handler", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("data-zfb-reload");
  });
});

describe("shared presentational components", () => {
  it("renders PhotoGrid with its stable verification selector", () => {
    expect(render(<PhotoGrid><li>Photo</li></PhotoGrid>)).toMatch(/<ul[^>]*data-testid="photo-grid"/);
  });
  it("provides one stable polite feed status node without replacing the real anchor", () => {
    const html = render(<PhotoFeed
      scope="global"
      page={{ page: 1, pageSize: 24, totalItems: 25, totalPages: 2, offset: 0, hasPrev: false, hasNext: true }}
      nextHref="/page/2"
      photos={[]}
    />);
    expect(html).toContain('data-gallery-next-link="true"');
    expect(html).toContain('data-gallery-status="true" aria-live="polite" aria-atomic="true" hidden');
  });
  it("renders the PhotoCard structural and metadata contract", () => {
    const html = render(<PhotoCard photo={{ id: 7, title: "Acrylic macro", src: "/img/photo.webp", width: 2000, height: 1500, blurhash: null }} />);
    expect(html).toMatch(/^<li data-photo-id="7">/); expect(html).toContain('<a href="/photos/7"');
    expect(html).toContain('width="2000"'); expect(html).toContain('height="1500"');
    expect(html).toContain('alt="Acrylic macro"');
    expect(html).toContain("[object-fit:var(--gallery-thumbnail-object-fit)]");
  });
  it("renders a bounded cover placeholder only for a valid hash while keeping the image visible by default", () => {
    const photo = { id: 1, title: "Photo", src: "/img/photo.webp", width: 2400, height: 1600, blurhash: VALID_BLURHASH };
    const html = render(<PhotoCard photo={photo} />);
    expect(html).toContain('data-image-placeholder="true"');
    expect(html).toContain('data-placeholder-fit="cover"');
    expect(html).toContain('data-placeholder-image="true"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toContain("data-placeholder-pending");
    expect(render(<PhotoCard photo={{ ...photo, blurhash: "not-a-hash" }} />)).not.toContain("data-image-placeholder");
    expect(render(<PhotoCard photo={{ ...photo, blurhash: "x".repeat(100_000) }} />)).not.toContain("data-image-placeholder");
    expect(render(<PhotoCard photo={{ ...photo, blurhash: null }} />)).not.toContain("data-image-placeholder");
  });
  it("uses lazy loading by default and eager loading for priority photos", () => {
    const photo = { id: 1, title: "Photo", src: "/img/photo.webp", width: 20, height: 20, blurhash: null };
    expect(render(<PhotoCard photo={photo} />)).toContain('loading="lazy"');
    const priority = render(<PhotoCard photo={photo} priority />);
    expect(priority).toContain('loading="eager"'); expect(priority).not.toContain('loading="lazy"');
  });
  it("emits responsive image attributes only with a srcSet", () => {
    const photo = { id: 1, title: "Photo", src: "/img/photo.webp", width: 20, height: 20, blurhash: null };
    const plain = render(<PhotoCard photo={photo} sizes="20px" />);
    expect(plain).not.toMatch(/srcset=/i); expect(plain).not.toContain("sizes=");
    const responsive = render(<PhotoCard photo={photo} srcSet="/img/photo.webp 20w" />);
    expect(responsive).toMatch(/srcset=/i); expect(responsive).toContain('sizes="(min-width: 48rem) 200px, 100vw"');
  });
  it("renders a marked one-page feed without a misleading next action", () => {
    const html = render(<PhotoFeed
      scope="global"
      page={{ page: 1, pageSize: 24, totalItems: 1, totalPages: 1, offset: 0, hasPrev: false, hasNext: false }}
      nextHref="/page/2"
      photos={[{ id: 7, title: "Photo", r2_key: "photos/7.jpg", thumb_key: null, width: 1200, height: 800, blurhash: null }]}
    />);
    expect(html).toContain('data-gallery-feed="true"');
    expect(html).toContain('data-gallery-scope="global"');
    expect(html).toContain('data-gallery-page="1"');
    expect(html).toContain('data-gallery-total-pages="1"');
    expect(html).toContain('data-gallery-total-items="1"');
    expect(html).toContain('data-gallery-page-size="24"');
    expect(html).toContain('data-gallery-next-url');
    expect(html).toContain('data-gallery-next-count="0"');
    expect(html).toContain('data-gallery-terminal="true"');
    expect(html).toContain('data-photo-id="7"');
    expect(html).not.toContain('data-gallery-next-link');
  });
  it("renders an exact next-X link for a partial remainder", () => {
    const html = render(<PhotoFeed
      scope="tag:3"
      page={{ page: 1, pageSize: 24, totalItems: 25, totalPages: 2, offset: 0, hasPrev: false, hasNext: true }}
      nextHref="/tags/foo/page/2"
      photos={Array.from({ length: 24 }, (_, id) => ({ id, title: `Photo ${id}`, r2_key: `photos/${id}.jpg`, thumb_key: null, width: 1200, height: 800, blurhash: null }))}
    />);
    expect(html).toContain('data-gallery-scope="tag:3"');
    expect(html).toContain('data-gallery-next-url="/tags/foo/page/2"');
    expect(html).toContain('data-gallery-next-count="1"');
    expect(html).toContain('data-gallery-terminal="false"');
    expect(html).toContain('href="/tags/foo/page/2"');
    expect(html).toContain(">Load next 1 photos</a>");
  });
  it("keeps an expanded placeholder-bearing cardsHtml payload below the 512 KiB entry cap", () => {
    const cardsHtml = render(<PhotoGrid>{Array.from({ length: 240 }, (_, id) => (
      <PhotoCard key={id} photo={{
        id, title: `Photo ${id}`, src: `/img/${id}.webp`, width: 2400, height: 1600, blurhash: VALID_BLURHASH,
      }} />
    ))}</PhotoGrid>);
    expect(cardsHtml).toContain("data:image/png;base64,");
    expect(utf8ByteLength(cardsHtml)).toBeLessThan(DEFAULT_SNAPSHOT_LIMITS.maxEntryBytes);
  });
  it("renders tag text and applies percent encoding exactly once", () => {
    const html = render(<TagList tags={[{ name: "acrylic" }, { name: "東京" }]} />);
    expect(html).toContain("#acrylic"); expect(html).toContain('href="/tags/acrylic"');
    expect(html).toContain(`/tags/${encodeURIComponent("東京")}`); expect(html).not.toContain("%25");
  });
  it("wires Field labels, errors, and descriptions", () => {
    const invalid = render(<Field id="email" name="email" label="Email" error="Required" />);
    expect(invalid).toContain('for="email"'); expect(invalid).toContain('id="email"');
    expect(invalid).toContain('aria-invalid="true"'); expect(invalid).toContain('aria-describedby="email-error"');
    const valid = render(<Field id="name" name="name" label="Name" />);
    expect(valid).not.toContain("aria-invalid"); expect(valid).not.toContain("aria-describedby");
  });
  it("renders textarea state in the element body", () => {
    const html = render(<Field id="notes" name="notes" label="Notes" as="textarea" value="Server value" />);
    expect(html).toMatch(/<textarea[^>]*>Server value<\/textarea>/); expect(html).not.toMatch(/<textarea[^>]*value=/);
  });
  it("defaults Button to submit and renders link-buttons without button attributes", () => {
    const button = render(<Button>Save</Button>);
    expect(button).toMatch(/^<button[^>]*type="submit"/); expect(button).toContain("cursor-pointer");
    const link = render(<Button href="/upload">Upload</Button>);
    expect(link).toMatch(/^<a href="\/upload"/); expect(link).not.toContain('type="submit"');
  });
  it("renders EmptyState title and action", () => {
    const html = render(<EmptyState title="Nothing here" action={{ href: "/upload", label: "Upload" }} />);
    expect(html).toContain("Nothing here"); expect(html).toContain('href="/upload"');
  });
});
