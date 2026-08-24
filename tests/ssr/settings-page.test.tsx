import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { SettingsView } from "../../pages/settings";

describe("settings page SSR contract", () => {
  it("renders three POST settings forms, multipart fallback, and intentional runtime scripts", () => {
    const html = render(
      <SettingsView
        account={{
          id: 7,
          username: "alice",
          email: "alice@example.com",
          avatar_key: "avatars/avatar-7.png",
          created_at: "2026-08-22 00:00:00",
        }}
        sessionUser={{ id: 7, username: "alice", email: "alice@example.com", avatar_key: "avatars/avatar-7.png" }}
      />,
    );

    const settingsForms = html.match(/<form[^>]*method="post"[^>]*action="\/settings"/g) ?? [];
    expect(settingsForms).toHaveLength(3);
    expect(html).toContain('name="intent" value="rename"');
    expect(html).toContain('name="intent" value="avatar"');
    expect(html).toContain('name="intent" value="delete"');
    expect(html).toMatch(/<form[^>]*action="\/settings"[^>]*enctype="multipart\/form-data"/);
    expect(html).toContain('name="confirm"');
    expect(html).toContain('width="96"');
    expect(html).toContain('height="96"');
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).toContain("data-theme-bootstrap");
    expect(html).toContain('type="module" src="/assets/islands.js"');
    expect(html).not.toContain("data-zfb-reload");
  });
});
