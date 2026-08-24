export const CANVAS = Object.freeze({ width: 1200, height: 630 });
export const BG = "#141210";

export const BOX = Object.freeze({ x: 60, y: 60, width: 510, height: 510 });
export const LOGO_BOX = Object.freeze({ x: 660, y: 90, width: 450, height: 450 });

export const BLEED = 60;
export const SHADOW_BLUR = 25;
export const SHADOW_OPACITY = 1;
export const SHADOW_OFFSET_Y = 16;

export function expandBox(box, amount) {
  return {
    x: box.x - amount,
    y: box.y - amount,
    width: box.width + amount * 2,
    height: box.height + amount * 2,
  };
}

export function offsetBox(box, offsetX, offsetY) {
  return {
    x: box.x + offsetX,
    y: box.y + offsetY,
    width: box.width,
    height: box.height,
  };
}

export function containsBox(outer, inner) {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export const PHOTO_BLEED_BOX = Object.freeze(expandBox(BOX, BLEED));
export const SHADOW_BOX = Object.freeze(offsetBox(PHOTO_BLEED_BOX, 0, SHADOW_OFFSET_Y));
