import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import GalleryLayout from "../../layouts/gallery-layout";

describe("GalleryLayout", () => {
  it("links the stable stylesheet path the postbuild step creates", () => {
    expect(render(<GalleryLayout title="Gallery">x</GalleryLayout>))
      .toContain('<link rel="stylesheet" href="/assets/app.css"');
  });
});
