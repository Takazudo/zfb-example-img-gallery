import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync("styles/global.css", "utf8");
const semanticColors = [
  "ink", "ink-soft", "ink-faint", "paper", "surface", "surface-sunken", "line",
  "line-strong", "brand", "brand-strong", "brand-soft", "accent", "success",
  "success-soft", "danger", "danger-soft", "on-brand", "on-danger",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("semantic theme architecture", () => {
  it("keeps raw OKLCH values in the palette and exposes only semantic Tailwind colors", () => {
    expect(globalCss).toContain("@theme inline {");
    expect(globalCss).toContain("--color-*: initial;");

    for (const color of semanticColors) {
      expect(globalCss).toContain(`--theme-${color}: var(--palette-`);
      expect(globalCss).toContain(`--color-${color}: var(--theme-${color});`);
    }

    const rawColorDeclarations = globalCss
      .split("\n")
      .filter((line) => line.includes("oklch("));
    expect(rawColorDeclarations.length).toBeGreaterThan(0);
    expect(rawColorDeclarations.every((line) => line.trimStart().startsWith("--palette-"))).toBe(true);
  });

  it("maps OS-default, forced light, and forced dark theme selection", () => {
    expect(globalCss).toMatch(/:root,\s*html\[data-theme="light"\]\s*{[^}]*color-scheme:\s*light/s);
    expect(globalCss).toMatch(/@media \(prefers-color-scheme:\s*dark\)\s*{\s*html:not\(\[data-theme\]\)\s*{[^}]*color-scheme:\s*dark/s);
    expect(globalCss).toMatch(/html\[data-theme="dark"\]\s*{[^}]*color-scheme:\s*dark/s);

    const lightMappings = globalCss.match(/:root,\s*html\[data-theme="light"\]\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const osDarkMappings = globalCss.match(/html:not\(\[data-theme\]\)\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const darkMappings = globalCss.match(/html\[data-theme="dark"\]\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    for (const color of semanticColors) {
      expect(lightMappings).toContain(`--theme-${color}: var(--palette-`);
      expect(osDarkMappings).toContain(`--theme-${color}: var(--palette-`);
      expect(darkMappings).toContain(`--theme-${color}: var(--palette-`);
    }
  });

  it("preserves focus and reduces utility and root view-transition motion", () => {
    expect(globalCss).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--theme-brand\)/s);
    expect(globalCss).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(globalCss).toContain('[class*="group-hover:scale-"]');
    expect(globalCss).toContain("::view-transition-group(root)");
    expect(globalCss).toContain("::view-transition-old(root)");
    expect(globalCss).toContain("::view-transition-new(root)");
  });

  it("rejects default palettes, raw colors, and palette references in Preact markup", () => {
    const source = ["components", "islands", "layouts", "pages"]
      .filter((directory) => existsSync(directory))
      .flatMap((directory) => sourceFiles(directory))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const defaultPalette = /(?:^|[\s"'`])(?:[a-z-]+:)*(?:bg|text|border|outline|ring|fill|stroke|from|via|to|divide|decoration|caret|accent)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-|\/|[\s"'`])/g;
    const arbitraryRawColor = /(?:bg|text|border|outline|ring|fill|stroke|from|via|to|divide|decoration|caret|accent)-\[(?:#|rgb\(|hsl\(|oklch\(|var\(--palette-)/g;

    expect(source.match(defaultPalette) ?? []).toEqual([]);
    expect(source.match(arbitraryRawColor) ?? []).toEqual([]);
    expect(source).not.toContain("var(--palette-");
  });

  it("does not alter gallery media colors for theming", () => {
    expect(globalCss).not.toMatch(/(?:img|picture|video)[^{]*{[^}]*filter\s*:/s);
  });
});
