import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { AuthForm } from "../../components/auth-form";

describe("authentication form SSR contract", () => {
  it("renders the register form with frozen fields and server error markup", () => {
    const html = render(
      <AuthForm
        mode="register"
        username="alice"
        email="alice@example.com"
        error="That username is taken."
      />,
    );
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/register"/);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('minlength="8"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("That username is taken.");
    expect(html).toContain('type="submit"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toContain("correct horse battery staple");
  });

  it("renders the login form and cross-link without a username field", () => {
    const html = render(<AuthForm mode="login" email="alice@example.com" />);
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/login"/);
    expect(html).not.toContain('name="username"');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('href="/register"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});
