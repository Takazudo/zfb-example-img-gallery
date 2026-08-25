import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const globalCss = readFileSync("styles/global.css", "utf8");
const semanticColors = [
  "ink", "ink-soft", "ink-faint", "paper", "surface", "surface-sunken", "line",
  "line-strong", "brand", "brand-strong", "brand-soft", "accent", "success",
  "success-soft", "danger", "danger-soft", "on-brand", "on-danger",
] as const;
const themeRoles = [...semanticColors, "shadow-soft", "shadow-strong"] as const;

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

    for (const role of themeRoles) {
      expect(globalCss).toContain(`--theme-${role}: var(--palette-`);
    }
    for (const color of semanticColors) {
      expect(globalCss).toContain(`--color-${color}: var(--theme-${color});`);
    }

    const paletteDefinitions = new Set(
      [...globalCss.matchAll(/--(?<token>palette-[\w-]+):/g)].map((match) => match.groups?.token),
    );
    const paletteReferences = new Set(
      [...globalCss.matchAll(/var\(--(?<token>palette-[\w-]+)\)/g)].map((match) => match.groups?.token),
    );
    expect([...paletteReferences].filter((token) => !paletteDefinitions.has(token))).toEqual([]);

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
    for (const role of themeRoles) {
      expect(lightMappings).toContain(`--theme-${role}: var(--palette-`);
      expect(osDarkMappings).toContain(`--theme-${role}: var(--palette-`);
      expect(darkMappings).toContain(`--theme-${role}: var(--palette-`);
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

  it("uses cover/contain placeholders and transitions only image opacity", () => {
    expect(globalCss).toMatch(/\[data-image-placeholder="true"\]::before\s*{[^}]*background-size:\s*cover/s);
    expect(globalCss).toMatch(/\[data-placeholder-fit="contain"\][^}]*::before\s*{[^}]*background-size:\s*contain/s);
    const imageRule = globalCss.match(/\[data-placeholder-image="true"\]\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    expect(imageRule).toContain("transition: opacity 180ms ease;");
    expect(imageRule).not.toMatch(/transition:\s*(?:all|transform|width|height)/);
    expect(globalCss).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*transition-duration:\s*0\.01ms !important/);
  });

  it("wires thumbnail preferences to intrinsic media and responsive grid tokens", () => {
    expect(globalCss).toContain("--gallery-thumbnail-aspect-ratio: 1 / 1;");
    expect(globalCss).toContain("--gallery-thumbnail-width: 12.5rem;");
    expect(globalCss).toContain('html[data-thumb-ratio="original"]');
    expect(globalCss).toContain("--gallery-thumbnail-aspect-ratio: auto;");
    expect(globalCss).toContain("--gallery-thumbnail-object-fit: contain;");
    expect(readFileSync("components/photo-grid.tsx", "utf8")).toContain(
      "minmax(min(100%,var(--gallery-thumbnail-width)),1fr)",
    );
    expect(readFileSync("components/photo-card.tsx", "utf8")).toContain('class="photo-card-image"');
    expect(globalCss).toContain("aspect-ratio: var(--gallery-thumbnail-aspect-ratio);");
  });

  it("keeps card actions in distinct 44px-class corners and the modal viewport-bound", () => {
    expect(globalCss).toMatch(/\.favorite-action-card\s*{[^}]*right:[^}]*bottom:/s);
    expect(globalCss).toMatch(/\.photo-delete-form-card\s*{[^}]*top:[^}]*right:/s);
    expect(globalCss).toMatch(/\.photo-select-action\s*{[^}]*top:[^}]*left:/s);
    expect(globalCss).toMatch(/\.photo-delete-action,[\s\S]*?\.photo-select-action\s*{[^}]*width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/s);
    expect(globalCss).toMatch(/\.photo-select-action input\s*{[^}]*accent-color:\s*var\(--theme-brand\)/s);
    expect(globalCss).toMatch(/\.photo-delete-dialog\s*{[^}]*width:\s*min\(32rem, calc\(100vw - 2rem\)\);[^}]*max-height:\s*calc\(100dvh - 2rem\)/s);
  });
});
