import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const fixture = fileURLToPath(new URL("../fixtures/exif-orientation-6.jpg", import.meta.url));

describe("OG deployed-preview fixture", () => {
  it("retains the non-default EXIF orientation used by the production gate", async () => {
    const metadata = await sharp(fixture).metadata();

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(240);
    expect(metadata.height).toBe(360);
    expect(metadata.orientation).toBe(6);
    expect(metadata.autoOrient).toEqual({ width: 360, height: 240 });
  });
});
