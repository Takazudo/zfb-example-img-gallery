import { expect, test } from "@playwright/test";
import { onePxPng, uploadPng } from "./fixtures";

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
  await page.goto("/register");
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => url.pathname !== "/register"),
    page.click('button[type="submit"]'),
  ]);
  expect(new URL(page.url()).pathname).not.toBe("/register");

  let cookies = await page.context().cookies();
  if (!cookies.some((cookie) => cookie.name === "sid")) {
    await page.goto("/login");
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForURL((url) => url.pathname !== "/login"),
      page.click('button[type="submit"]'),
    ]);
    cookies = await page.context().cookies();
  }
  expect(cookies.some((cookie) => cookie.name === "sid")).toBe(true);

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
  await Promise.all([
    page.waitForURL(/\/photos\/\d+$/),
    page.click('button[type="submit"]'),
  ]);
  const photoPath = new URL(page.url()).pathname;

  await page.goto("/");
  const gridPhoto = page.locator(`a[href="${photoPath}"]`);
  await expect(gridPhoto).toBeVisible();
  await expect(gridPhoto.locator("img")).toHaveAttribute("width", /\d+/);
  await expect(gridPhoto.locator("img")).toHaveAttribute("height", /\d+/);

  await page.goto(photoPath);
  await expect(page.locator("h1")).toContainText(title);
  await expect(page.locator(`a[href="/authors/${username}"]`)).toHaveText(`@${username}`);
  await expect(page.locator("p.whitespace-pre-wrap")).toHaveText(description);
  await expect(page.locator("p.whitespace-pre-wrap em, p.whitespace-pre-wrap strong")).toHaveCount(0);
  await expect(page.locator('a[href="/tags/e2e-smoke"]')).toBeVisible();
  await expect(page.locator(`a[href="/tags/${uniqueTag}"]`)).toBeVisible();

  await page.goto("/tags/e2e-smoke");
  await expect(page.locator("h1")).toHaveText("#e2e-smoke");
  await expect(page.locator(`a[href="${photoPath}"]`)).toBeVisible();

  const ogImage = await page.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toBeTruthy();
  expect(ogImage!).toMatch(/^https?:\/\//);
  // The tag is authoritative for the path and generation. Local zfb keeps the
  // production canonical origin, so retain that path while addressing the
  // request to this test's wrangler server.
  const localOgImage = new URL(new URL(ogImage!).pathname, page.url()).toString();
  const response = await page.request.get(localOgImage);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/jpeg");
});

test("serves the gallery without client JavaScript", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("script")).toHaveCount(0);

  const photoHref = await page.locator('a[href^="/photos/"]').first().getAttribute("href");
  await page.goto(photoHref ?? "/photos/1");
  await expect(page.locator("script")).toHaveCount(0);

  await page.goto("/tags");
  await expect(page.locator("script")).toHaveCount(0);
});
