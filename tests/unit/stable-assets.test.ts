import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The postbuild helper intentionally remains executable JavaScript.
import { copyStableAssets, discoverGeneratedIslandsEntry, islandRegistrations } from "../../scripts/stable-assets.mjs";

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
  // zfb 3 client manifest shape: __zfb_register(component, exportName, identity, sourcePath).
  const source = entrySource ?? `import "./islands-chunk-chunkhash.js";function r(e,t,n,s){m[n]={identity:{component:n,build:"0123456789abcdef"}}}r(Tt,"ThemeToggle","ThemeToggle","components/theme-toggle.tsx");const route="/my-photos";`;
  writeFileSync(join(assets, "islands-entryhash.js"), source);
  writeFileSync(join(project, "dist", "index.html"), '<script src="/assets/islands-entryhash.js"></script>');
  writeFileSync(join(project, "dist", "nested", "index.html"), '<script src="../assets/islands-entryhash.js"></script>');
  return { project, assets, source };
}

describe("stable generated assets", () => {
  it("preserves portable source labels and bytes while rehashing every HTML reference", () => {
    const data = fixture();
    try {
      const result = copyStableAssets(data.assets, data.project);
      expect(result.islandsEntry).toBe(`islands-${hash(data.source)}.js`);
      expect(readFileSync(join(data.assets, result.islandsEntry), "utf8")).toBe(data.source);
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
      const normalized = matching.source;
      const target = `islands-${hash(normalized)}.js`;
      writeFileSync(join(matching.assets, target), normalized);
      expect(copyStableAssets(matching.assets, matching.project).islandsEntry).toBe(target);
      expect(readFileSync(join(matching.assets, "islands.js"), "utf8")).toBe(normalized);
    } finally { rmSync(matching.project, { recursive: true }); }

    const conflict = fixture();
    try {
      const oldPath = join(conflict.assets, "islands-entryhash.js");
      const oldBytes = readFileSync(oldPath);
      const normalized = conflict.source;
      const target = `islands-${hash(normalized)}.js`;
      writeFileSync(join(conflict.assets, target), "conflict");
      expect(() => copyStableAssets(conflict.assets, conflict.project)).toThrow(/already exists with different bytes/);
      expect(readFileSync(oldPath)).toEqual(oldBytes);
      expect(readFileSync(join(conflict.assets, target), "utf8")).toBe("conflict");
      expect(readFileSync(join(conflict.project, "dist", "index.html"), "utf8")).toContain("islands-entryhash.js");
    } finally { rmSync(conflict.project, { recursive: true }); }
  });

  it.each(["/checkout/components/theme-toggle.tsx", "C:\\checkout\\components\\theme-toggle.tsx", "file:///checkout/components/theme-toggle.tsx"])("rejects upstream absolute diagnostic regression %s before mutation", (path) => {
    const source = `r(n,"x","X",${JSON.stringify(path)});`;
    const data = fixture(source);
    try {
      expect(() => copyStableAssets(data.assets, data.project)).toThrow(/absolute diagnostic source path/);
      expect(readFileSync(join(data.assets, "islands-entryhash.js"), "utf8")).toBe(source);
      expect(readFileSync(join(data.project, "dist", "index.html"), "utf8")).toContain("islands-entryhash.js");
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

  it("reads island identities from the zfb 3 client manifest registrations", () => {
    const source = 'function r(e,t,n,s){}r(A,"DisplaySettings","DisplaySettings","components/display-settings.tsx");'
      + 'r(B,"ThemeToggle","ThemeToggle","/abs/components/theme-toggle.tsx");const unrelated=f(x,"a","b","c");';
    expect(islandRegistrations(source)).toEqual([
      { exportName: "DisplaySettings", identity: "DisplaySettings", sourcePath: "components/display-settings.tsx" },
      { exportName: "ThemeToggle", identity: "ThemeToggle", sourcePath: "/abs/components/theme-toggle.tsx" },
    ]);
  });
});
