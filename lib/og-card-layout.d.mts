export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const CANVAS: Readonly<Size>;
export const BG: "#141210";
export const BOX: Readonly<Box>;
export const LOGO_BOX: Readonly<Box>;
export const BLEED: 60;
export const SHADOW_BLUR: 25;
export const SHADOW_OPACITY: 1;
export const SHADOW_OFFSET_Y: 16;
export const PHOTO_BLEED_BOX: Readonly<Box>;
export const SHADOW_BOX: Readonly<Box>;

export function expandBox(box: Box, amount: number): Box;
export function offsetBox(box: Box, offsetX: number, offsetY: number): Box;
export function containsBox(outer: Box, inner: Box): boolean;
