import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { Button } from "../../components/button";
import { EmptyState } from "../../components/empty-state";
import { Field } from "../../components/field";
import { Pagination } from "../../components/pagination";
import { PhotoCard } from "../../components/photo-card";
import { PhotoGrid } from "../../components/photo-grid";
import { TagList } from "../../components/tag-list";
import GalleryLayout from "../../layouts/gallery-layout";
import { THEME_BOOTSTRAP_SCRIPT } from "../../lib/theme";

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
    expect(html).toContain(`<script data-theme-bootstrap="true">${THEME_BOOTSTRAP_SCRIPT}</script>`);
    expect(html.indexOf("data-theme-bootstrap")).toBeLessThan(html.indexOf('href="/assets/app.css"'));
  });
  it("mounts the uniform SPA router policy and preserves its announcer styles", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html).toContain('name="zfb-view-transitions-enabled" content="true"');
    expect(html).toContain('name="zfb-view-transitions-fallback" content="animate"');
    expect(html).toContain('name="zfb-preserve-html-attrs" content="data-theme"');
    expect(html).toContain('name="zfb-traverse-refetch" content="true"');
    expect(html).toContain(".zfb-route-announcer");
  });
  it("mounts the stable accessible theme island in the wrapping header nav", () => {
    const html = render(<GalleryLayout>content</GalleryLayout>);
    expect(html).toContain('data-zfb-island="ThemeToggle"');
    expect(html).toContain('data-when="load"');
    expect(html).toContain('aria-label="Switch to dark mode"');
    expect(html).toMatch(/<nav[^>]*>[\s\S]*data-zfb-island="ThemeToggle"[\s\S]*<\/nav>/);
    const props = html.match(/data-zfb-island="ThemeToggle"[^>]*data-props="([^"]*)"/)?.[1];
    expect(props).toBeUndefined();
  });
  it("suppresses only the manual stable module for the SSG document mode", () => {
    const html = render(<GalleryLayout includeStableClientEntry={false}>content</GalleryLayout>);
    expect(html).not.toContain('src="/assets/islands.js"');
    expect(html).toContain('data-zfb-island="ThemeToggle"');
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
  it("renders the PhotoCard structural and metadata contract", () => {
    const html = render(<PhotoCard photo={{ id: 7, title: "Acrylic macro", src: "/img/photo.webp", width: 2000, height: 1500 }} />);
    expect(html).toMatch(/^<li>/); expect(html).toContain('<a href="/photos/7"');
    expect(html).toContain('width="2000"'); expect(html).toContain('height="1500"');
    expect(html).toContain('alt="Acrylic macro"'); expect(html).toContain("object-cover");
  });
  it("uses lazy loading by default and eager loading for priority photos", () => {
    const photo = { id: 1, title: "Photo", src: "/img/photo.webp", width: 20, height: 20 };
    expect(render(<PhotoCard photo={photo} />)).toContain('loading="lazy"');
    const priority = render(<PhotoCard photo={photo} priority />);
    expect(priority).toContain('loading="eager"'); expect(priority).not.toContain('loading="lazy"');
  });
  it("emits responsive image attributes only with a srcSet", () => {
    const photo = { id: 1, title: "Photo", src: "/img/photo.webp", width: 20, height: 20 };
    const plain = render(<PhotoCard photo={photo} sizes="20px" />);
    expect(plain).not.toMatch(/srcset=/i); expect(plain).not.toContain("sizes=");
    const responsive = render(<PhotoCard photo={photo} srcSet="/img/photo.webp 20w" />);
    expect(responsive).toMatch(/srcset=/i); expect(responsive).toContain('sizes="(min-width: 48rem) 200px, 100vw"');
  });
  it("omits Pagination for a one-page collection", () => {
    expect(render(<Pagination page={1} pageCount={1} href={(page) => `/page/${page}`} />)).toBe("");
  });
  it("renders Pagination with its URL builder and accessibility states", () => {
    const html = render(<Pagination page={1} pageCount={13} href={(page) => `/tags/foo/page/${page}`} />);
    expect(html).toContain('href="/tags/foo/page/2"'); expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(1); expect(html.match(/aria-hidden="true"/g)).toHaveLength(1);
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
