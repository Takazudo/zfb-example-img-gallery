import { describe, expect, it } from "vitest";

// The implementation is intentionally a dependency-light executable `.mjs`
// script; Vitest executes it directly while TypeScript has no declaration-file
// convention for this repo's scripts.
// @ts-expect-error Runtime-only JavaScript script module.
import { FACETS, classifyColour, marginGate, normalizeTags, selectFacet, sentenceFromFacets } from "../../scripts/describe-photos.mjs";
// @ts-expect-error Runtime-only JavaScript script module.
import { DEAD_SLUGS, parseSlug, titleFromSlug } from "../../scripts/lib/slug-taxonomy.mjs";

import { readFileSync } from "node:fs";

describe("slug taxonomy", () => {
  it("matches the longest family prefix and keeps variant tokens", () => {
    const parsed = parseSlug("zudo-block-60x2-view5");
    expect(parsed.family).toBe("zudo-block-60x2");
    expect(parsed.displayName).toBe("Zudo Block 60x2");
    expect(parsed.variantTokens).toEqual(["view5"]);
    expect(parsed.viewHint).toBe("detail view");
  });

  it("falls back to title-casing an unknown family", () => {
    const parsed = parseSlug("mystery-product-view-5");
    expect(parsed.family).toBeNull();
    expect(parsed.displayName).toBe("Mystery Product View 5");
    expect(parsed.variantTokens).toEqual(["mystery", "product", "view", "5"]);
    expect(parsed.viewHint).toBe("detail view");
  });

  it("preserves title injectivity at digit/token boundaries and across slugs.txt", () => {
    expect(titleFromSlug("zudo-block-60x2-view5")).not.toBe(titleFromSlug("zudo-block-60x2-view-5"));
    const slugs = readFileSync("data/photos/slugs.txt", "utf8").trim().split(/\r?\n/);
    const titles = slugs.map(titleFromSlug);
    expect(slugs).toHaveLength(293);
    expect(new Set(titles).size).toBe(293);
    expect(slugs.some((slug) => DEAD_SLUGS.includes(slug))).toBe(false);
  });
});

describe("facet gating", () => {
  it("drops a margin below 0.005 and keeps one above it", () => {
    expect(selectFacet([
      { label: "top", score: 0.104 },
      { label: "runner", score: 0.100 },
    ])).toBeNull();
    expect(selectFacet([
      { label: "top", score: 0.106 },
      { label: "runner", score: 0.100 },
    ])).toBe("top");
    // The contract says `< 0.005` is dropped; exactly 0.005 is therefore kept.
    expect(marginGate(0.105, 0.1)).toBe(true);
  });

  it("exposes the curated facet vocabulary", () => {
    expect(FACETS.form).toContain("an enclosure");
    expect(FACETS.material).toContain("3d printed");
    expect(FACETS.view).toContain("assembled build");
    expect(FACETS.finish).toContain("transparent");
  });
});

function pixels(width: number, height: number, background: [number, number, number], subject?: {
  x: number;
  y: number;
  width: number;
  height: number;
  rgb: [number, number, number];
}) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inSubject = subject
        && x >= subject.x
        && x < subject.x + subject.width
        && y >= subject.y
        && y < subject.y + subject.height;
      const rgb = inSubject ? subject.rgb : background;
      const offset = (y * width + x) * 3;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
    }
  }
  return { data, width, height };
}

describe("pixel colour classifier", () => {
  it("separates a coloured subject from a contrasting backdrop", () => {
    const result = classifyColour(pixels(64, 64, [220, 220, 220], {
      x: 12,
      y: 12,
      width: 40,
      height: 40,
      rgb: [220, 40, 40],
    }));
    expect(result.colour).toBe("red");
    expect(result.background).toBe("light grey");
    expect(result.coverage).toBeGreaterThan(0.3);
  });

  it("uses clear for low coverage and transparent finishes", () => {
    const sparse = classifyColour(pixels(64, 64, [220, 220, 220], {
      x: 27,
      y: 27,
      width: 10,
      height: 10,
      rgb: [220, 40, 40],
    }));
    expect(sparse.colour).toBe("clear");

    const transparent = classifyColour(pixels(64, 64, [220, 220, 220], {
      x: 12,
      y: 12,
      width: 40,
      height: 40,
      rgb: [220, 40, 40],
    }), 64, 64, "transparent");
    expect(transparent.colour).toBe("clear");
  });
});

describe("tag normalisation", () => {
  it("strips a hash, normalises unicode, joins whitespace, and dedupes", () => {
    expect(normalizeTags(" #Hello   World,ｈｅｌｌｏ　ｗｏｒｌｄ,#other")).toEqual(["hello-world", "other"]);
    expect(normalizeTags(["#one,two"])).toEqual(["one", "two"]);
  });

  it("rejects unsafe/control tags and enforces ten tags plus code-point bounds", () => {
    expect(normalizeTags("safe/path,percent%,question?,hash#\u0001")).toEqual([]);
    expect(normalizeTags(["😀".repeat(20)])).toEqual(["😀".repeat(20)]);
    expect(normalizeTags(["😀".repeat(33)])).toEqual([]);
    expect(normalizeTags(Array.from({ length: 12 }, (_, index) => `tag-${index}`))).toHaveLength(10);
  });
});

describe("description sentence", () => {
  it("omits every dropped facet cleanly", () => {
    const values = [null, "dark grey"] as const;
    for (const colour of values) {
      for (const material of values) {
        for (const form of values) {
          for (const view of values) {
            for (const background of values) {
              const sentence = sentenceFromFacets("Zudo Block", {
                colour,
                material,
                form,
                view,
                finish: null,
                background,
              });
              expect(sentence).not.toMatch(/ {2,}/u);
              expect(sentence).not.toMatch(/,\s*\./u);
              expect(sentence).toMatch(/\.$/u);
            }
          }
        }
      }
    }
    expect(sentenceFromFacets("Zudo Block", {
      colour: null,
      material: null,
      form: null,
      view: null,
      finish: null,
      background: null,
    })).toBe("A Zudo Block, from the modular enclosure series.");
  });
});
