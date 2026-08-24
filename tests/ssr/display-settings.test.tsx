import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { DisplaySettings } from "../../components/display-settings";

describe("DisplaySettings", () => {
  it("keeps stable island identity and withholds the no-JavaScript trigger", () => {
    expect(DisplaySettings.name).toBe("DisplaySettings");
    expect(DisplaySettings.displayName).toBe("DisplaySettings");
    const html = render(<DisplaySettings />);
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).not.toMatch(/<button[^>]*>Display settings<\/button>/);
  });

  it("server-renders a labelled native dialog and labelled radio groups", () => {
    const html = render(<DisplaySettings />);
    expect(html).toMatch(/^<dialog/);
    expect(html).toContain('aria-labelledby="display-settings-title"');
    expect(html).toContain('<h2 id="display-settings-title"');
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    expect(html).toContain('<legend');
    expect(html).toContain('>Thumbnail ratio</legend>');
    expect(html).toContain('>Thumbnail width</legend>');
    expect(html.match(/type="radio"/g)).toHaveLength(7);
    expect(html.match(/name="thumbnail-ratio"/g)).toHaveLength(4);
    expect(html.match(/name="thumbnail-width"/g)).toHaveLength(3);
    expect(html).toContain('value="square" checked');
    expect(html).toContain('value="medium" checked');
  });

  it("renders every exact option label and minimum-sized interactive target", () => {
    const html = render(<DisplaySettings />);
    for (const label of [
      "Original",
      "Portrait 3:4",
      "Square 1:1",
      "Landscape 4:3",
      "Small",
      "Medium",
      "Large",
    ]) expect(html).toContain(label);
    expect(html.match(/min-h-\[2\.75rem\]/g)?.length).toBeGreaterThanOrEqual(8);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*value="close"/);
    expect(html).toContain(">Close</button>");
  });
});
