import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The postbuild helper intentionally remains executable JavaScript.
import { copyStableAssets, discoverGeneratedIslandsEntry } from "../../scripts/stable-assets.mjs";

function hash(source: string) { return createHash("sha256").update(source).digest("hex").slice(0, 8); }

function fixture(entrySource?: string) {
  const project = mkdtempSync(join(tmpdir(), "zfb-stable-assets-"));
  const assets = join(project, "dist", "assets");
  mkdirSync(join(project, "components"), { recursive: true });
  mkdirSync(join(project, "dist", "nested"), { recursive: true });
  writeFileSync(join(project, "components", "theme-toggle.tsx"), "export default 1");
  writeFileSync(join(project, "components", "gallery.tsx"), "export default 2");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "styles-csshash.css"), "body{}");
  writeFileSync(join(assets, "islands-chunk-chunkhash.js"), "export default 1;");
  writeFileSync(join(assets, "islands-resource-helper.js"), "export default 2;");
  const absolute = join(project, "components", "theme-toggle.tsx");
  const source = entrySource ?? `import "./islands-chunk-chunkhash.js";r(ns,"default","ThemeToggle",${JSON.stringify(absolute)});const route="/my-photos";`;
  writeFileSync(join(assets, "islands-entryhash.js"), source);
  writeFileSync(join(project, "dist", "index.html"), '<script src="/assets/islands-entryhash.js"></script>');
  writeFileSync(join(project, "dist", "nested", "index.html"), '<script src="../assets/islands-entryhash.js"></script>');
  return { project, assets, source };
}

describe("stable generated assets", () => {
  it("normalizes path formats, preserves unrelated strings/imports, rehashes, and updates every HTML", () => {
    const data = fixture();
    try {
      const posix = join(data.project, "components", "theme-toggle.tsx");
      const gallery = join(data.project, "components", "gallery.tsx");
      const windows = `C:${gallery.replaceAll("/", "\\")}`;
      const slashWindows = `D:${posix}`;
      const file = new URL(`file://${gallery}`).href;
      const source = `import "./islands-chunk-chunkhash.js";const rx=/(a,b)/;const template=\`({not syntax})\`;a(n,"x","A",${JSON.stringify(posix)});b(n,"x","B",${JSON.stringify(windows)});c(n,"x","C",${JSON.stringify(slashWindows)});d(n,"x","D",${JSON.stringify(file)});const route="/my-photos";`;
      writeFileSync(join(data.assets, "islands-entryhash.js"), source);
      const result = copyStableAssets(data.assets, data.project);
      const expected = source.replace(JSON.stringify(posix), '"components/theme-toggle.tsx"').replace(JSON.stringify(windows), '"components/gallery.tsx"').replace(JSON.stringify(slashWindows), '"components/theme-toggle.tsx"').replace(JSON.stringify(file), '"components/gallery.tsx"');
      expect(result.islandsEntry).toBe(`islands-${hash(expected)}.js`);
      expect(readFileSync(join(data.assets, result.islandsEntry), "utf8")).toBe(expected);
      expect(expected).toContain('const route="/my-photos"');
      expect(readFileSync(join(data.project, "dist", "index.html"), "utf8")).toContain(result.islandsEntry);
      expect(readFileSync(join(data.project, "dist", "nested", "index.html"), "utf8")).toContain(result.islandsEntry);
      expect(readFileSync(join(data.assets, "islands.js"))).toEqual(readFileSync(join(data.assets, result.islandsEntry)));
      expect(readFileSync(join(data.assets, "app.css"))).toEqual(readFileSync(join(data.assets, "styles-csshash.css")));
      expect(() => readFileSync(join(data.assets, "islands-entryhash.js"))).toThrow();
    } finally { rmSync(data.project, { recursive: true }); }
  });

  it("is deterministic when repeated and keeps an already-correct hash", () => {
    const data = fixture();
    try {
      const first = copyStableAssets(data.assets, data.project);
      const firstBytes = readFileSync(join(data.assets, first.islandsEntry));
      const second = copyStableAssets(data.assets, data.project);
      expect(second).toEqual(first);
      expect(readFileSync(join(data.assets, second.islandsEntry))).toEqual(firstBytes);
      expect(discoverGeneratedIslandsEntry(data.assets)).toBe(first.islandsEntry);
    } finally { rmSync(data.project, { recursive: true }); }
  });

  it("accepts a matching target and preserves conflicting files without mutation", () => {
    const matching = fixture();
    try {
      const normalized = matching.source.replace(JSON.stringify(join(matching.project, "components", "theme-toggle.tsx")), '"components/theme-toggle.tsx"');
      const target = `islands-${hash(normalized)}.js`;
      writeFileSync(join(matching.assets, target), normalized);
      expect(copyStableAssets(matching.assets, matching.project).islandsEntry).toBe(target);
      expect(readFileSync(join(matching.assets, "islands.js"), "utf8")).toBe(normalized);
    } finally { rmSync(matching.project, { recursive: true }); }

    const conflict = fixture();
    try {
      const oldPath = join(conflict.assets, "islands-entryhash.js");
      const oldBytes = readFileSync(oldPath);
      const normalized = conflict.source.replace(JSON.stringify(join(conflict.project, "components", "theme-toggle.tsx")), '"components/theme-toggle.tsx"');
      const target = `islands-${hash(normalized)}.js`;
      writeFileSync(join(conflict.assets, target), "conflict");
      expect(() => copyStableAssets(conflict.assets, conflict.project)).toThrow(/already exists with different bytes/);
      expect(readFileSync(oldPath)).toEqual(oldBytes);
      expect(readFileSync(join(conflict.assets, target), "utf8")).toBe("conflict");
      expect(readFileSync(join(conflict.project, "dist", "index.html"), "utf8")).toContain("islands-entryhash.js");
    } finally { rmSync(conflict.project, { recursive: true }); }
  });

  it.each([
    ["outside-root", (project: string) => `r(n,"x","X",${JSON.stringify(join(project, "..", "outside.tsx"))});`, /outside repository/],
    ["missing", (project: string) => `r(n,"x","X",${JSON.stringify(join(project, "components", "missing.tsx"))});`, /unresolved/],
    ["malformed file URL", () => 'r(n,"x","X","file:%zz/missing.tsx");', /malformed diagnostic file URL/],
  ])("fails safely for %s diagnostic candidates", (_name, source, error) => {
    const data = fixture();
    try {
      writeFileSync(join(data.assets, "islands-entryhash.js"), source(data.project));
      expect(() => copyStableAssets(data.assets, data.project)).toThrow(error);
      expect(readFileSync(join(data.assets, "islands-entryhash.js"), "utf8")).toBe(source(data.project));
    } finally { rmSync(data.project, { recursive: true }); }
  });

  it("fails when a Windows diagnostic can resolve to multiple in-repository files", () => {
    const data = fixture();
    try {
      const rootName = basename(data.project);
      mkdirSync(join(data.project, "one", rootName), { recursive: true });
      writeFileSync(join(data.project, "one", rootName, "two.tsx"), "one");
      writeFileSync(join(data.project, "two.tsx"), "two");
      const ambiguous = `C:\\prefix\\${rootName}\\one\\${rootName}\\two.tsx`;
      const source = `r(n,"x","X",${JSON.stringify(ambiguous)});`;
      writeFileSync(join(data.assets, "islands-entryhash.js"), source);
      expect(() => copyStableAssets(data.assets, data.project)).toThrow(/ambiguous diagnostic source path/);
      expect(readFileSync(join(data.assets, "islands-entryhash.js"), "utf8")).toBe(source);
    } finally { rmSync(data.project, { recursive: true }); }
  });

  it("fails on ambiguous entries, dangling references, and missing relative imports", () => {
    const ambiguous = fixture();
    try {
      writeFileSync(join(ambiguous.assets, "islands-extra.js"), "export{};");
      expect(() => copyStableAssets(ambiguous.assets, ambiguous.project)).toThrow(/ambiguous generated islands entries/);
    } finally { rmSync(ambiguous.project, { recursive: true }); }
    const dangling = fixture();
    try {
      writeFileSync(join(dangling.project, "dist", "nested", "index.html"), '<script src="/assets/islands-missing.js"></script>');
      expect(() => copyStableAssets(dangling.assets, dangling.project)).toThrow(/expected exactly one.*referenced.*found 2/);
    } finally { rmSync(dangling.project, { recursive: true }); }
    const missing = fixture();
    try {
      rmSync(join(missing.assets, "islands-chunk-chunkhash.js"));
      expect(() => copyStableAssets(missing.assets, missing.project)).toThrow(/references missing relative asset/);
    } finally { rmSync(missing.project, { recursive: true }); }
  });

  it("fails when the generated entry itself is missing", () => {
    const data = fixture();
    try {
      rmSync(join(data.assets, "islands-entryhash.js"));
      expect(() => copyStableAssets(data.assets, data.project)).toThrow(/dangling generated islands reference/);
    } finally { rmSync(data.project, { recursive: true }); }
  });
});
