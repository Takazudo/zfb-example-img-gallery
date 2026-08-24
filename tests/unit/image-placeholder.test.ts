import { describe, expect, it } from "vitest";
import {
  createImagePlaceholder,
  isCanonicalPhotoBlurhash,
  PLACEHOLDER_MAX_DATA_URI_BYTES,
  PLACEHOLDER_MAX_PIXELS,
  placeholderDimensions,
} from "../../lib/image-placeholder";

const VALID_HASH = "Ub86Xpt:fQt:t:o#fQo#fQfQfQfQt:o#fQo#";

describe("bounded SSR image placeholders", () => {
  it("accepts only the canonical fixed-4x4/base83 form", () => {
    expect(isCanonicalPhotoBlurhash(VALID_HASH)).toBe(true);
    expect(isCanonicalPhotoBlurhash(null)).toBe(false);
    expect(isCanonicalPhotoBlurhash(`T${VALID_HASH.slice(1)}`)).toBe(false);
    expect(isCanonicalPhotoBlurhash(`${VALID_HASH.slice(0, -1)}!`)).toBe(false);
    expect(isCanonicalPhotoBlurhash(`${VALID_HASH}x`)).toBe(false);
  });

  it("clamps hostile dimensions before preserving a bounded aspect ratio", () => {
    expect(placeholderDimensions(Number.POSITIVE_INFINITY, -10)).toEqual({ width: 16, height: 16 });
    expect(placeholderDimensions(1_000_000_000, 1)).toEqual({ width: 16, height: 4 });
    expect(placeholderDimensions(1, 1_000_000_000)).toEqual({ width: 4, height: 16 });
    const landscape = placeholderDimensions(2400, 1600);
    expect(landscape).toEqual({ width: 16, height: 11 });
    expect(landscape.width * landscape.height).toBeLessThanOrEqual(PLACEHOLDER_MAX_PIXELS);
  });

  it("decodes valid hashes to a bounded serializable PNG and fails closed", () => {
    const placeholder = createImagePlaceholder(VALID_HASH, 2400, 1600);
    expect(placeholder).not.toBeNull();
    expect(placeholder?.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(new TextEncoder().encode(placeholder?.dataUri).byteLength).toBeLessThanOrEqual(PLACEHOLDER_MAX_DATA_URI_BYTES);
    expect(createImagePlaceholder(null, 1, 1)).toBeNull();
    expect(createImagePlaceholder("x".repeat(100_000), 1, 1)).toBeNull();
    const adversarial = createImagePlaceholder(`U${"~".repeat(35)}`, 1, 1);
    expect(adversarial === null || new TextEncoder().encode(adversarial.dataUri).byteLength <= PLACEHOLDER_MAX_DATA_URI_BYTES).toBe(true);
  });
});
