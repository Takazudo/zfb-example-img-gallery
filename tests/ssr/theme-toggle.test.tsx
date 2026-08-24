import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { ThemeToggle } from "../../components/theme-toggle";

describe("ThemeToggle", () => {
  it("has stable island identity", () => {
    expect(ThemeToggle.name).toBe("ThemeToggle");
    expect(ThemeToggle.displayName).toBe("ThemeToggle");
  });

  it("renders deterministic accessible button markup", () => {
    const first = render(<ThemeToggle />);
    const second = render(<ThemeToggle />);
    expect(first).toBe(second);
    expect(first).toMatch(/^<button[^>]*type="button"/);
    expect(first).toContain('aria-label="Switch to dark mode"');
    expect(first).toContain("min-h-[2.75rem]");
    expect(first).toContain("min-w-[2.75rem]");
    expect(first).toContain("focus-visible:outline");
  });

  it("renders a decorative current-color icon", () => {
    const html = render(<ThemeToggle />);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('stroke="currentColor"');
    expect(html).not.toMatch(/<svg[^>]*(?:aria-label|role)=/);
  });
});
