import { describe, expect, it } from "vitest";
import {
  getEditorialRole,
  encodeGalleryLayoutClass,
  getGalleryLayoutRoles,
  getJustifiedRole,
  getSafeIntrinsicAspectRatio,
  getSpotlightRole,
} from "../../lib/gallery-layout-roles";

describe("deterministic gallery layout roles", () => {
  it("promotes the exact rotating slot in each 17-card Spotlight module", () => {
    expect([0, 16, 17, 18, 21, 33, 34, 42, 50, 51, 63, 67, 68].map((index) => [index, getSpotlightRole(index)]))
      .toEqual([
        [0, { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }],
        [16, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [17, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [18, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [21, { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }],
        [33, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [34, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [42, { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }],
        [50, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [51, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [63, { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }],
        [67, { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 }],
        [68, { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }],
      ]);
  });

  it("repeats the exact 11-card Editorial role sequence across page and cycle boundaries", () => {
    expect(Array.from({ length: 11 }, (_, index) => getEditorialRole(index))).toEqual([
      { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 },
      { role: "wide", columnStart: 3, columnSpan: 2, rowSpan: 1 },
      { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
      { role: "tall", columnStart: 1, columnSpan: 1, rowSpan: 2 },
      { role: "standard", columnStart: 2, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 2, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
      { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
    ]);
    for (const index of [10, 11, 12, 23, 24, 25]) {
      expect(getEditorialRole(index)).toEqual(getEditorialRole(index % 11));
    }
  });

  it("repeats the exact 12-column Justified rows", () => {
    expect(Array.from({ length: 11 }, (_, index) => getJustifiedRole(index))).toEqual([
      { columnStart: 1, columnSpan: 5 }, { columnStart: 6, columnSpan: 3 }, { columnStart: 9, columnSpan: 4 },
      { columnStart: 1, columnSpan: 3 }, { columnStart: 4, columnSpan: 6 }, { columnStart: 10, columnSpan: 3 },
      { columnStart: 1, columnSpan: 4 }, { columnStart: 5, columnSpan: 4 }, { columnStart: 9, columnSpan: 4 },
      { columnStart: 1, columnSpan: 7 }, { columnStart: 8, columnSpan: 5 },
    ]);
    for (const index of [10, 11, 12, 23, 24, 25]) {
      expect(getJustifiedRole(index)).toEqual(getJustifiedRole(index % 11));
    }
  });

  it("normalizes unsafe source dimensions and emits stable combined metadata", () => {
    expect(getSafeIntrinsicAspectRatio(1200, 800)).toBe(1.5);
    expect(getSafeIntrinsicAspectRatio(1, 1_000_000_000)).toBe(1e-9);
    for (const dimensions of [[0, 20], [-1, 20], [20, 0], [Infinity, 20], [20, NaN]]) {
      expect(getSafeIntrinsicAspectRatio(dimensions[0]!, dimensions[1]!)).toBe(1);
    }
    expect(getGalleryLayoutRoles(24, 1200, 800)).toEqual({
      spotlight: { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 },
      editorial: { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
      justified: { columnStart: 9, columnSpan: 4 },
      intrinsicAspectRatio: 1.5,
    });
    expect([0, 4, 10, 11, 17, 21].map(encodeGalleryLayoutClass))
      .toEqual(["gf0", "gs4", "gsa", "gs0", "gs6", "gfa"]);
  });
});
