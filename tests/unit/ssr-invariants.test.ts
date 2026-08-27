import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// The scanner is intentionally a plain executable `.mjs`; keep the test's
// narrow import typed locally without adding a production declaration file.
// @ts-expect-error The JavaScript scanner has no generated declaration file.
import { scanBuildOutput, scanPagePrerenderExports } from "../../scripts/assert-ssr-invariants.mjs";

const PORTABLE_IDENTIFIERS = [
  "components/display-settings.tsx",
  "components/infinite-gallery-controller.tsx",
  "components/theme-toggle.tsx",
];

function hash(source: string) {
  return createHash("sha256").update(source).digest("hex").slice(0, 8);
}

function entrySource(extra = "") {
  return [
    'import "./islands-chunk-def456.js";',
    `register(ns,"default","DisplaySettings","${PORTABLE_IDENTIFIERS[0]}");`,
    `register(ns,"default","InfiniteGalleryController","${PORTABLE_IDENTIFIERS[1]}");`,
    `register(ns,"default","ThemeToggle","${PORTABLE_IDENTIFIERS[2]}");`,
    'const webPaths = ["/assets/app.js", "https://cdn.example.test/components/external.tsx", "//cdn.example.test/runtime.js"];',
    extra,
  ].join("\n");
}

function valid404(entryName: string) {
  return `<!doctype html><html><head>
<script data-theme-bootstrap>(()=>{})();</script>
<style>.zfb-route-announcer{position:absolute}</style>
<meta name="zfb-view-transitions-enabled" content="true">
<meta name="zfb-view-transitions-fallback" content="animate">
<meta name="zfb-preserve-html-attrs" content="data-theme data-thumb-ratio data-thumb-width data-gallery-layout">
<meta name="zfb-traverse-refetch" content="true">
<link rel="stylesheet" href="/assets/app.css">
<script type="module" src="/assets/${entryName}"></script>
</head><body><div data-zfb-island="ThemeToggle" data-when="load"></div><div data-zfb-island="DisplaySettings" data-when="load"><dialog aria-labelledby="display-settings-title"><h2 id="display-settings-title">Display settings</h2><fieldset><legend>Gallery layout</legend><input type="radio" name="gallery-layout"><input type="radio" name="gallery-layout"><input type="radio" name="gallery-layout"><input type="radio" name="gallery-layout"><input type="radio" name="gallery-layout"></fieldset><fieldset><legend>Thumbnail ratio</legend><input type="radio" name="thumbnail-ratio"><input type="radio" name="thumbnail-ratio"><input type="radio" name="thumbnail-ratio"><input type="radio" name="thumbnail-ratio"></fieldset><fieldset><legend>Thumbnail width</legend><input type="radio" name="thumbnail-width"><input type="radio" name="thumbnail-width"><input type="radio" name="thumbnail-width"></fieldset></dialog></div></body></html>`;
}

type FixtureOptions = {
  source?: string;
  entryName?: string;
  chunkSource?: string;
  stableSource?: string;
};

function buildFixture(options: FixtureOptions = {}) {
  const source = options.source ?? entrySource();
  const entryName = options.entryName;
  const chunkSource = options.chunkSource ?? "export const hydrated = true;";
  const stableSource = options.stableSource ?? source;
  const root = mkdtempSync(join(tmpdir(), "zfb-ssr-invariant-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  const generatedName = entryName ?? `islands-${hash(source)}.js`;
  writeFileSync(join(root, "404.html"), valid404(generatedName));
  writeFileSync(join(root, "_worker.js"), "worker");
  writeFileSync(join(root, "_zfb_inner.mjs"), "worker");
  writeFileSync(join(assets, "islands-chunk-def456.js"), chunkSource);
  writeFileSync(join(assets, generatedName), source);
  writeFileSync(join(assets, "islands.js"), stableSource);
  return { root, assets, generatedName, source };
}

describe("SSR invariants", () => {
  it("marks every runtime page as non-prerendered", () => {
    expect(scanPagePrerenderExports(resolve(process.cwd(), "pages"))).toEqual([]);
  });

  it("accepts valid portable output and only the reachable generated runtime graph", () => {
    const data = buildFixture();
    try {
      expect(scanBuildOutput(data.root)).toEqual([]);
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("rejects an extra client bundle and an arbitrary executable script", () => {
    const data = buildFixture();
    try {
      writeFileSync(join(data.assets, "surprise.js"), "alert(1)");
      writeFileSync(join(data.assets, "_worker.js"), "not an adapter entry");
      writeFileSync(join(data.root, "404.html"), valid404(data.generatedName).replace("</head>", "<script>alert(1)</script></head>"));
      const problems = scanBuildOutput(data.root);
      expect(problems).toContain("unexpected client JavaScript artifact: assets/surprise.js");
      expect(problems).toContain("unexpected client JavaScript artifact: assets/_worker.js");
      expect(problems).toContain("404.html contains an unexpected executable or inline module script");
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("rejects a duplicate stable entry and byte drift", () => {
    const data = buildFixture({ stableSource: "different" });
    try {
      writeFileSync(join(data.root, "404.html"), valid404(data.generatedName).replace("</head>", '<script type="module" src="/assets/islands.js"></script></head>'));
      const problems = scanBuildOutput(data.root);
      expect(problems).toContain(`assets/islands.js bytes differ from assets/${data.generatedName}`);
      expect(problems).toContain("404.html must not load the stable /assets/islands.js alias");
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("rejects an inert SSR settings trigger and incomplete radio semantics", () => {
    const data = buildFixture();
    try {
      const broken = valid404(data.generatedName)
        .replace("<dialog", '<button aria-haspopup="dialog">Display settings</button><dialog')
        .replace('<input type="radio" name="thumbnail-width">', "")
        .replace('<input type="radio" name="gallery-layout">', "");
      writeFileSync(join(data.root, "404.html"), broken);
      const problems = scanBuildOutput(data.root);
      expect(problems).toContain(
        "404.html must withhold the display-settings trigger until hydration",
      );
      expect(problems).toContain("404.html must contain three thumbnail-width radios");
      expect(problems).toContain("404.html must contain five gallery-layout radios");
      expect(problems).toContain("404.html must contain twelve display-settings radios");
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it.each([
    ["POSIX", "/tmp/checkout/components/theme-toggle.tsx", "an absolute POSIX source-module path"],
    ["Windows", "C:\\checkout\\components\\theme-toggle.tsx", "a Windows-drive source-module path"],
    ["file URL", "file:///tmp/checkout/components/theme-toggle.tsx", "a file: source-module diagnostic"],
  ])("rejects a leaked %s diagnostic in a reachable client asset", (_label, leaked, message) => {
    const data = buildFixture({ chunkSource: `const leaked = ${JSON.stringify(leaked)};` });
    try {
      const problems = scanBuildOutput(data.root);
      expect(problems).toContain(`assets/islands-chunk-def456.js contains ${message}: ${leaked}`);
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("rejects an islands filename whose digest does not match its final bytes", () => {
    const data = buildFixture({ entryName: "islands-deadbeef.js" });
    try {
      const problems = scanBuildOutput(data.root);
      expect(problems).toContain(
        `generated islands entry filename islands-deadbeef.js does not match final-byte SHA-256; expected islands-${hash(data.source)}.js`,
      );
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it.each([
    ["dangling", "islands-missing.js"],
    ["stale", "islands-deadbeef.js"],
  ])("rejects a %s SSG islands reference", (_label, reference) => {
    const data = buildFixture();
    try {
      writeFileSync(join(data.root, "404.html"), valid404(data.generatedName).replace(data.generatedName, reference));
      expect(scanBuildOutput(data.root)).toContain(
        `404.html must reference the finalized generated islands entry /assets/${data.generatedName}, found: /assets/${reference}`,
      );
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("rejects missing portable identifiers from the real generated entry", () => {
    const source = entrySource().replace(PORTABLE_IDENTIFIERS[1], "components/missing-controller.tsx");
    const data = buildFixture({ source });
    try {
      expect(scanBuildOutput(data.root)).toContain(
        "generated islands entry is missing portable source identifier: components/infinite-gallery-controller.tsx",
      );
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });

  it("reports a dangling relative chunk instead of throwing", () => {
    const data = buildFixture({ source: entrySource().replace('import "./islands-chunk-def456.js";', 'import "./islands-missing.js";') });
    try {
      expect(scanBuildOutput(data.root)).toContain(
        "generated islands entry references missing artifact: assets/islands-missing.js",
      );
    } finally {
      rmSync(data.root, { recursive: true });
    }
  });
});
