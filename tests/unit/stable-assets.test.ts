import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The postbuild helper intentionally remains executable JavaScript.
import { copyStableAssets, discoverGeneratedIslandsEntry } from "../../scripts/stable-assets.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zfb-stable-assets-"));
  writeFileSync(join(root, "styles-csshash.css"), "body{}");
  writeFileSync(join(root, "islands-chunk-chunkhash.js"), "export default 1;");
  writeFileSync(join(root, "islands-resource-helper.js"), "export default 2;");
  writeFileSync(
    join(root, "islands-entryhash.js"),
    'import chunk from "./islands-chunk-chunkhash.js"; import helper from "./islands-resource-helper.js";',
  );
  return root;
}

describe("stable generated assets", () => {
  it("excludes chunks/resources, copies the entry byte-for-byte, and preserves relative imports", () => {
    const root = fixture();
    try {
      expect(discoverGeneratedIslandsEntry(root)).toBe("islands-entryhash.js");
      const result = copyStableAssets(root);
      expect(result).toEqual({ cssEntry: "styles-csshash.css", islandsEntry: "islands-entryhash.js" });
      expect(readFileSync(join(root, "app.css"))).toEqual(readFileSync(join(root, "styles-csshash.css")));
      expect(readFileSync(join(root, "islands.js"))).toEqual(readFileSync(join(root, "islands-entryhash.js")));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("fails loudly when the entry is missing or ambiguous", () => {
    const root = fixture();
    try {
      writeFileSync(join(root, "islands-secondhash.js"), "export {};");
      expect(() => discoverGeneratedIslandsEntry(root)).toThrow(/expected exactly one.*found 2/);
      rmSync(join(root, "islands-entryhash.js"));
      rmSync(join(root, "islands-secondhash.js"));
      expect(() => discoverGeneratedIslandsEntry(root)).toThrow(/expected exactly one.*found 0/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("fails when a generated relative import cannot resolve", () => {
    const root = fixture();
    try {
      rmSync(join(root, "islands-chunk-chunkhash.js"));
      expect(() => copyStableAssets(root)).toThrow(/references missing relative asset/);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
