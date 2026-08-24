import { expect, test } from "@playwright/test";
import { onePxPng, uploadPng } from "./fixtures";
import { softSubmit } from "./navigation";

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const username = `e2e${runId}`;
const email = `e2e-${runId}@example.test`;
const password = `Pw-${runId}-aA1!`;
const title = `E2E smoke ${runId}`;
const description = `Uploaded by the e2e smoke run ${runId}. *Plain* _text_.`;
const uniqueTag = `e2e-${runId}`;

test.beforeEach(async ({ page }) => {
  // Stub photo bytes. The grid and detail pages are the assertions; the actual
  // R2 payloads are not, and on a seeded database page 1 would otherwise pull
  // 24 multi-hundred-KB originals per navigation. The glob deliberately covers
  // ONLY /img/** — /og/** must reach the real Worker.
  await page.route("**/img/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: onePxPng() }),
  );
});

test("registers, uploads, browses, and fetches the social card @smoke", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));

  // Validation responses are also router-intercepted POSTs: they keep the
  // current URL and replace only the document while preserving the form state.
  await page.goto("/login");
  await page.fill('input[name="email"]', "nobody@example.test");
  await page.fill('input[name="password"]', "wrongpass");
  const invalidLoginSwap = await softSubmit(page, "/login", "Sign in");
  expect(new URL(invalidLoginSwap.finalUrl).pathname).toBe("/login");
  await expect(page.getByRole("alert")).toContainText("Email or password is incorrect.");

  await page.goto("/register");
  await page.fill('input[name="username"]', "x");
  await page.fill('input[name="email"]', "invalid-register@example.test");
  await page.fill('input[name="password"]', "short");
  const invalidRegisterSwap = await softSubmit(page, "/register", "Create account");
  expect(new URL(invalidRegisterSwap.finalUrl).pathname).toBe("/register");
  await expect(page.getByRole("alert")).toContainText("Username must be 3–24 characters.");

  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  const registerSwap = await softSubmit(page, "/register", "Create account");

  let cookies = await page.context().cookies();
  if (!cookies.some((cookie) => cookie.name === "sid")) {
    await page.goto("/login");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    const loginSwap = await softSubmit(page, "/login", "Sign in");
    expect(new URL(loginSwap.finalUrl).pathname).toBe("/");
    cookies = await page.context().cookies();
  } else {
    expect(new URL(registerSwap.finalUrl).pathname).toBe("/");
  }
  expect(cookies.some((cookie) => cookie.name === "sid")).toBe(true);
  await expect(page.getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  await page.goto("/upload");
  await page.setInputFiles('input[name="photo"]', {
    name: "e2e-sample.png",
    mimeType: "image/png",
    buffer: uploadPng(),
  });
  await page.fill('input[name="title"]', title);
  await page.fill('textarea[name="description"]', description);
  // "#E2E Smoke" exercises the normaliser: strip the leading '#', NFKC,
  // lowercase, collapse internal whitespace to '-' => "e2e-smoke".
  await page.fill('input[name="tags"]', `#E2E Smoke, ${uniqueTag}`);
  const uploadSwap = await softSubmit(page, "/upload", "Upload photo");
  expect(new URL(uploadSwap.finalUrl).pathname).toMatch(/^\/photos\/\d+$/);
  const photoPath = new URL(page.url()).pathname;
  await expect(page.getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  await page.goto("/");
  const gridPhoto = page.locator(`a[href="${photoPath}"]`);
  await expect(gridPhoto).toBeVisible();
  await expect(gridPhoto.locator("img")).toHaveAttribute("width", /\d+/);
  await expect(gridPhoto.locator("img")).toHaveAttribute("height", /\d+/);

  // Exercise both bare collection roots through real browser navigations.
  // Their `/*` entries in `run_worker_first` do not match the roots, so this
  // catches the otherwise easy-to-miss Static Assets 404-page regression.
  await page.goto("/authors");
  await expect(page.locator("h1")).toHaveText("Authors");
  await expect(page.locator(`main a[href="/authors/${username}"]`)).toBeVisible();

  await page.goto(`/authors/${username}`);
  await expect(page.locator("h1")).toHaveText(`@${username}`);
  await expect(page.locator(`a[href="${photoPath}"]`)).toBeVisible();

  await page.goto(photoPath);
  await expect(page.locator("h1")).toContainText(title);
  await expect(
    page.getByTestId("photo-detail-aside").locator(`a[href="/authors/${username}"]`),
  ).toHaveText(`@${username}`);
  await expect(page.locator("p.whitespace-pre-wrap")).toHaveText(description);
  await expect(page.locator("p.whitespace-pre-wrap em, p.whitespace-pre-wrap strong")).toHaveCount(0);
  await expect(page.locator('a[href="/tags/e2e-smoke"]')).toBeVisible();
  await expect(page.locator(`a[href="/tags/${uniqueTag}"]`)).toBeVisible();

  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toBeTruthy();
  expect(ogImage!).toMatch(/^https?:\/\//);
  const ogUrl = new URL(ogImage!);
  expect(ogUrl.pathname).toBe(`/og/v1/${photoPath.split("/").at(-1)}.jpg`);

  await page.goto("/tags");
  await expect(page.locator("h1")).toHaveText("Tags");
  await expect(page.locator('a[href="/tags/e2e-smoke"]')).toBeVisible();

  await page.goto("/tags/e2e-smoke");
  await expect(page.locator("h1")).toHaveText("#e2e-smoke");
  await expect(page.locator(`a[href="${photoPath}"]`)).toBeVisible();

  // The meta tag is authoritative for the path and generation. Local zfb keeps the
  // production canonical origin, so retain that path while addressing the
  // request to this test's wrangler server.
  const localOgImage = new URL(ogUrl.pathname, page.url()).toString();
  const response = await page.request.get(localOgImage);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/jpeg");

  await page.goto("/settings");
  const renamedUsername = `${username}x`;
  await page.fill('input[name="username"]', renamedUsername);
  const settingsSwap = await softSubmit(page, "/settings", "Save username");
  expect(new URL(settingsSwap.finalUrl).pathname).toBe("/settings");
  await expect(page.locator('input[name="username"]')).toHaveValue(renamedUsername);
  await expect(page.getByRole("link", { name: `@${renamedUsername}`, exact: true })).toBeVisible();

  const logoutSwap = await softSubmit(page, "/logout", "Sign out");
  expect(new URL(logoutSwap.finalUrl).pathname).toBe("/");
  expect((await page.context().cookies()).some((cookie) => cookie.name === "sid")).toBe(false);
  await expect(page.getByRole("link", { name: "Sign in", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Register", exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

async function expectRuntimeInventory(page: import("@playwright/test").Page) {
  await expect(page.locator('script[data-theme-bootstrap]')).toHaveCount(1);
  await expect(page.locator('script[type="module"][src="/assets/islands.js"]')).toHaveCount(1);
  const executableScripts = await page.locator('script:not([type="application/ld+json"])').evaluateAll((scripts) =>
    scripts.map((script) => ({
      type: script.getAttribute("type") ?? "",
      src: script.getAttribute("src"),
      bootstrap: script.hasAttribute("data-theme-bootstrap"),
    })),
  );
  expect(executableScripts).toEqual([
    { type: "", src: null, bootstrap: true },
    { type: "module", src: "/assets/islands.js", bootstrap: false },
  ]);
  const runtimeAsset = await page.request.get(new URL("/assets/islands.js", page.url()).toString());
  expect(runtimeAsset.status()).toBe(200);
  expect(runtimeAsset.headers()["content-type"]).toContain("javascript");
}

test("serves the intentional theme/router runtime inventory @smoke", async ({ page }) => {

  await page.goto("/");
  await expectRuntimeInventory(page);

  const photoLinks = page.locator('a[href^="/photos/"]');
  if ((await photoLinks.count()) > 0) {
    const photoHref = await photoLinks.first().getAttribute("href");
    expect(photoHref).toBeTruthy();
    await page.goto(photoHref!);
    await expectRuntimeInventory(page);
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
  }

  await page.goto("/tags");
  await expectRuntimeInventory(page);
});
