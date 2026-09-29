import { renderToString } from "@takazudo/zfb/zudo-react/server";
import { describe, expect, it } from "vitest";
import * as icons from "../../components/icons";

const iconNames = [
  "LayoutGridIcon",
  "ImagesIcon",
  "UsersIcon",
  "TagsIcon",
  "CameraIcon",
  "StarIcon",
  "UploadIcon",
  "SettingsIcon",
  "SunIcon",
  "MoonIcon",
  "SlidersHorizontalIcon",
  "CircleUserIcon",
  "LogInIcon",
  "LogOutIcon",
  "UserPlusIcon",
  "MenuIcon",
  "XIcon",
  "ChevronDownIcon",
] as const;

const iconEntries = iconNames.map((name) => [name, icons[name]] as const);

describe("line icon components", () => {
  it("exports exactly the requested glyphs", () => {
    expect(Object.keys(icons)).toEqual(iconNames);
  });

  it.each(iconEntries)("gives %s a stable component name", (name, Icon) => {
    expect(Icon.displayName).toBe(name);
    expect((Icon as unknown as { name: string }).name).toBe(name);
  });

  it.each(iconEntries)("renders %s with the shared decorative SVG contract", (_, Icon) => {
    const html = renderToString(<Icon />);
    const openingTag = html.slice(0, html.indexOf(">") + 1);

    expect(openingTag).toMatch(/^<svg\b/);
    expect(openingTag).toContain('viewBox="0 0 24 24"');
    expect(openingTag).toContain('width="24"');
    expect(openingTag).toContain('height="24"');
    expect(openingTag).toContain('fill="none"');
    expect(openingTag).toContain('stroke="currentColor"');
    expect(openingTag).toContain('stroke-width="2"');
    expect(openingTag).toContain('stroke-linecap="round"');
    expect(openingTag).toContain('stroke-linejoin="round"');
    expect(openingTag).toContain('aria-hidden="true"');
    // IE-only `focusable="false"` is rejected by zudo-react 3.0.0 (zudo-front-builder#3359);
    // modern browsers never focus an SVG without a tabindex.
    expect(openingTag).not.toMatch(/\b(?:tabindex|focusable)=/);
    expect(openingTag).toContain('class="size-5"');
    expect(html).not.toMatch(/aria-label=|\brole=|<title\b/);
  });

  it.each(iconEntries)("renders %s deterministically and honors class overrides", (_, Icon) => {
    const first = renderToString(<Icon class="size-4" />);
    const second = renderToString(<Icon class="size-4" />);

    expect(first).toBe(second);
    expect(first).toContain('class="size-4"');
    expect(first).not.toContain('class="size-5"');
  });
});
