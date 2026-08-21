import { describe, expect, it } from "vitest";
import { readImageDimensions } from "../../lib/image-dims";
import { jpegFixture, pngFixture, webpVp8Fixture, webpVp8lFixture, webpVp8xFixture } from "../helpers/mock-r2";

describe("readImageDimensions", () => {
  it.each([
    ["PNG", pngFixture(640, 480)],
    ["baseline JPEG", jpegFixture(800, 600)],
    ["progressive JPEG", jpegFixture(801, 601, 0xc2)],
    ["EXIF JPEG", jpegFixture(802, 602, 0xc0, true)],
    ["lossy WebP", webpVp8Fixture(803, 603)],
    ["lossless WebP", webpVp8lFixture(804, 604)],
    ["extended WebP", webpVp8xFixture(805, 605)],
  ])("reads %s dimensions", (_name, bytes) => {
    const expected = _name === "PNG" ? { width: 640, height: 480 }
      : _name === "baseline JPEG" ? { width: 800, height: 600 }
      : _name === "progressive JPEG" ? { width: 801, height: 601 }
      : _name === "EXIF JPEG" ? { width: 802, height: 602 }
      : _name === "lossy WebP" ? { width: 803, height: 603 }
      : _name === "lossless WebP" ? { width: 804, height: 604 }
      : { width: 805, height: 605 };
    expect(readImageDimensions(bytes)).toEqual(expected);
  });

  it.each([
    new Uint8Array(),
    pngFixture(1, 1).slice(0, 20),
    jpegFixture(1, 1).slice(0, 8),
    webpVp8xFixture(1, 1).slice(0, 25),
    new TextEncoder().encode("not an image"),
  ])("returns null for garbage or truncated input", (bytes) => {
    expect(readImageDimensions(bytes)).toBeNull();
  });

  it("does not mistake a DHT segment for a start-of-frame", () => {
    const dhtOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x07, 8, 0, 10, 0, 20]);
    expect(readImageDimensions(dhtOnly)).toBeNull();
  });

  it("requires PNG dimensions to come from the first IHDR chunk", () => {
    const bytes = pngFixture(10, 20);
    bytes.set([0x49, 0x44, 0x41, 0x54], 12);
    expect(readImageDimensions(bytes)).toBeNull();
  });

  it("rejects non-positive JPEG dimensions", () => {
    expect(readImageDimensions(jpegFixture(0, 20))).toBeNull();
    expect(readImageDimensions(jpegFixture(20, 0))).toBeNull();
  });
});
