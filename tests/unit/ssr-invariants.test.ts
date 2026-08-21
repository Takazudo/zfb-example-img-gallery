import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The scanner is intentionally a plain executable `.mjs`; keep the test's
// narrow import typed locally without adding a production declaration file.
// @ts-expect-error The JavaScript scanner has no generated declaration file.
import { scanPagePrerenderExports } from "../../scripts/assert-ssr-invariants.mjs";

describe("SSR invariants", () => {
  it("marks every runtime page as non-prerendered", () => {
    expect(scanPagePrerenderExports(resolve(process.cwd(), "pages"))).toEqual([]);
  });
});
