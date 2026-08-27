import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { PhotoFeed } from "../../components/photo-feed";
import type { PhotoCard } from "../../lib/types";

function photo(id: number): PhotoCard {
  return {
    id,
    user_id: 1,
    title: `Photo ${id}`,
    r2_key: `photos/${id}.jpg`,
    thumb_key: null,
    width: 1200,
    height: 800,
    blurhash: null,
    is_favorited: false,
  };
}

function feed(offset: number, ids: number[]): string {
  return render(<PhotoFeed
    scope="global"
    page={{ page: Math.floor(offset / 24) + 1, pageSize: 24, totalItems: 72, totalPages: 3, offset, hasPrev: offset > 0, hasNext: offset < 48 }}
    nextHref={`/page/${Math.floor(offset / 24) + 2}`}
    photos={ids.map(photo)}
  />);
}

function openingCard(html: string, id: number): string {
  return html.match(new RegExp(`<li[^>]*data-photo-id="${id}"[^>]*>`))?.[0] ?? "";
}

describe("PhotoFeed layout metadata", () => {
  it("keeps one semantic list with ordered direct photo-card children", () => {
    const html = feed(0, [0, 1, 2]);
    expect(html).toContain('<ul data-testid="photo-grid" data-gallery-grid="true" class="photo-grid">');
    expect(html.match(/<ul[^>]*>\s*<li data-photo-id="0"/)).not.toBeNull();
    expect(html.match(/<\/li>\s*<li data-photo-id="1"/)).not.toBeNull();
    expect(html.match(/<li data-photo-id=/g)).toHaveLength(3);
  });

  it("authors exact absolute-index roles around the 24-card page boundary", () => {
    const html = feed(23, [23, 24, 25]);
    expect(openingCard(html, 23)).toContain('class="photo-card gs1"');
    expect(openingCard(html, 24)).toContain('class="photo-card gs2"');
    expect(openingCard(html, 25)).toContain('class="photo-card gs3"');
    expect(openingCard(html, 23)).toContain('style="--a:1.5"');
  });

  it("authors identical metadata for direct and appended overlapping positions", () => {
    const direct = feed(24, [24, 25]);
    const appendedBatch = feed(0, Array.from({ length: 26 }, (_, id) => id));
    for (const id of [24, 25]) {
      const metadata = (html: string) => openingCard(html, id)
        .replace(new RegExp(`data-photo-id="${id}"`), 'data-photo-id="x"');
      expect(metadata(direct)).toBe(metadata(appendedBatch));
    }
  });

  it("keeps compact benign role attributes and intrinsic style in serialized cards", () => {
    const html = feed(0, Array.from({ length: 24 }, (_, id) => id));
    expect(html).toContain('class="photo-card gf0"');
    expect(html).toContain('class="photo-card gs4"');
    expect(html).toContain('class="photo-card gs9"');
    expect(html.length / 24).toBeLessThan(2_500);
    expect(html).not.toContain("tabindex");
  });
});
