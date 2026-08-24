import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The scanner is intentionally a plain executable `.mjs`; keep the test's
// narrow import typed locally without adding a production declaration file.
// @ts-expect-error The JavaScript scanner has no generated declaration file.
import { scanBuildOutput, scanPagePrerenderExports } from "../../scripts/assert-ssr-invariants.mjs";

const valid404 = `<!doctype html><html><head>
<script data-theme-bootstrap>(()=>{})();</script>
<style>.zfb-route-announcer{position:absolute}</style>
<meta name="zfb-view-transitions-enabled" content="true">
<meta name="zfb-preserve-html-attrs" content="data-theme">
<meta name="zfb-traverse-refetch" content="true">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/islands-abc123.js"></script>
</head><body><div data-zfb-island="ThemeToggle" data-when="load"></div></body></html>`;

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "zfb-ssr-invariant-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(root, "404.html"), valid404);
  writeFileSync(join(root, "_worker.js"), "worker");
  writeFileSync(join(root, "_zfb_inner.mjs"), "worker");
  writeFileSync(join(assets, "islands-chunk-def456.js"), "export const hydrated = true;");
  const entry = 'import "./islands-chunk-def456.js";';
  writeFileSync(join(assets, "islands-abc123.js"), entry);
  writeFileSync(join(assets, "islands.js"), entry);
  return root;
}

describe("SSR invariants", () => {
  it("marks every runtime page as non-prerendered", () => {
    expect(scanPagePrerenderExports(resolve(process.cwd(), "pages"))).toEqual([]);
  });

  it("accepts one SSG document and only the reachable generated runtime graph", () => {
    const root = buildFixture();
    try {
      expect(scanBuildOutput(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("rejects an extra client bundle and an arbitrary executable script", () => {
    const root = buildFixture();
    try {
      writeFileSync(join(root, "assets", "surprise.js"), "alert(1)");
      writeFileSync(join(root, "404.html"), valid404.replace("</head>", "<script>alert(1)</script></head>"));
      const problems = scanBuildOutput(root);
      expect(problems).toContain("unexpected client JavaScript artifact: assets/surprise.js");
      expect(problems).toContain("404.html contains an unexpected executable or inline module script");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("rejects a duplicate stable entry and byte drift", () => {
    const root = buildFixture();
    try {
      writeFileSync(join(root, "assets", "islands.js"), "different");
      writeFileSync(
        join(root, "404.html"),
        valid404.replace("</head>", '<script type="module" src="/assets/islands.js"></script></head>'),
      );
      const problems = scanBuildOutput(root);
      expect(problems).toContain("assets/islands.js bytes differ from assets/islands-abc123.js");
      expect(problems).toContain("404.html must not load the stable /assets/islands.js alias");
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
