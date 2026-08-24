import { describe, expect, it } from "vitest";

import {
  BLEED,
  BOX,
  CANVAS,
  LOGO_BOX,
  PHOTO_BLEED_BOX,
  SHADOW_BOX,
  SHADOW_OFFSET_Y,
  containsBox,
  expandBox,
  offsetBox,
} from "../../lib/og-card-layout.mjs";

const canvasBox = { x: 0, y: 0, ...CANVAS };

describe("OG card layout", () => {
  it("keeps the photo and logo boxes inside the canvas", () => {
    expect(containsBox(canvasBox, BOX)).toBe(true);
    expect(containsBox(canvasBox, LOGO_BOX)).toBe(true);
  });

  it("uses a square, vertically-centred photo container", () => {
    expect(BOX.width).toBe(BOX.height);
    expect(BOX.y * 2 + BOX.height).toBe(CANVAS.height);
  });

  it("expands the container by the exact bleed without scaling it", () => {
    expect(PHOTO_BLEED_BOX).toEqual(expandBox(BOX, BLEED));
    expect(PHOTO_BLEED_BOX).toEqual({ x: 0, y: 0, width: 630, height: 630 });
    expect(containsBox(PHOTO_BLEED_BOX, BOX)).toBe(true);
  });

  it("offsets the shadow downward while preserving its dimensions", () => {
    expect(SHADOW_BOX).toEqual(offsetBox(PHOTO_BLEED_BOX, 0, SHADOW_OFFSET_Y));
    expect(SHADOW_BOX).toEqual({ x: 0, y: 16, width: 630, height: 630 });
  });
});
