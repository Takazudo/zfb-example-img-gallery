import { expect, test, type Page, type Route } from "@playwright/test";
import { onePxPng, stubImageRequests } from "./fixtures";
import { softClick } from "./navigation";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;

function placeholder(page: Page, fit?: "cover" | "contain") {
  const selector = fit
    ? `[data-image-placeholder="true"][data-placeholder-fit="${fit}"]`
    : '[data-image-placeholder="true"]';
  return page.locator(selector).first();
}

async function releaseImages(routes: Route[]): Promise<void> {
  for (const route of routes.splice(0)) {
    await route.fulfill({ status: 200, contentType: "image/png", body: onePxPng() });
  }
}

test("keeps a delayed placeholder painted, then reveals success and respects reduced motion @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const held: Route[] = [];
  await page.route("**/img/**", (route) => {
    held.push(route);
  });

  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });
  const cover = placeholder(page, "cover");
  const image = cover.locator('img[data-placeholder-image="true"]');
  await expect(cover).toBeVisible();
  await expect(cover).toHaveAttribute("data-placeholder-pending", "true");
  await expect(image).toHaveCSS("opacity", "0");
  expect(await image.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe("0.01ms");
  expect(await cover.evaluate((node) => getComputedStyle(node, "::before").backgroundSize)).toBe("cover");

  await expect.poll(() => held.length).toBeGreaterThan(0);
  await releaseImages(held);
  await page.unroute("**/img/**");
  await expect(image).toHaveCSS("opacity", "1");
  await expect(cover).toHaveAttribute("data-placeholder-loaded", "true");
});

test("reveals image errors and leaves nullable rows immediately visible @smoke", async ({ page }) => {
  await page.route("**/img/**", (route) => route.fulfill({ status: 404, body: "missing fixture" }));
  await page.goto(FIXTURE_PATH, { waitUntil: "domcontentloaded" });

  const failed = placeholder(page);
  const failedImage = failed.locator('img[data-placeholder-image="true"]');
  await expect(failed).toHaveAttribute("data-placeholder-error", "true");
  await expect(failedImage).toHaveCSS("opacity", "1");

  const nullableImage = page.locator('img:not([data-placeholder-image="true"])').first();
  await expect(nullableImage).toBeVisible();
  await expect(nullableImage).toHaveCSS("opacity", "1");
  expect(await nullableImage.evaluate((node) => node.closest("[data-image-placeholder]") === null)).toBe(true);
});

test("uses cover in the grid, contain on detail, and keeps appended cards through Back @smoke", async ({ page }) => {
  await stubImageRequests(page);
  await page.goto(FIXTURE_PATH);

  const cover = placeholder(page, "cover");
  const detailHref = await cover.locator("xpath=ancestor::a[1]").getAttribute("href");
  expect(detailHref).toMatch(/^\/photos\/\d+$/);
  expect(await cover.evaluate((node) => getComputedStyle(node, "::before").backgroundSize)).toBe("cover");

  await page.locator('[data-gallery-next-link="true"]').click();
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(48);
  const appended = page.locator('[data-gallery-grid="true"] > li[data-photo-id] [data-image-placeholder="true"]').last();
  await appended.scrollIntoViewIfNeeded();
  await expect(appended).toHaveAttribute("data-placeholder-loaded", "true");

  await softClick(page, detailHref!);
  const contain = placeholder(page, "contain");
  await expect(contain).toBeVisible();
  expect(await contain.evaluate((node) => getComputedStyle(node, "::before").backgroundSize)).toBe("contain");
  await expect(contain.locator('img[data-placeholder-image="true"]')).toHaveCSS("opacity", "1");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PATH.replaceAll("/", "\\/")}$`));
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(48);
  await expect(page.locator('[data-gallery-grid="true"] [data-image-placeholder="true"]').last())
    .toHaveAttribute("data-placeholder-loaded", "true");
});

test("keeps placeholder content visible without JavaScript and exposes only the intended runtime @smoke", async ({ browser, page }) => {
  await stubImageRequests(page);
  await page.goto(FIXTURE_PATH);
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
  expect(await page.locator("[onclick], [onerror], [onload], [ontransitionend]").count()).toBe(0);

  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8788",
    javaScriptEnabled: false,
  });
  try {
    const noJs = await context.newPage();
    await noJs.goto(FIXTURE_PATH);
    const noJsPlaceholder = placeholder(noJs);
    await expect(noJsPlaceholder).toBeVisible();
    await expect(noJsPlaceholder.locator('img[data-placeholder-image="true"]')).toHaveCSS("opacity", "1");
    expect(await noJsPlaceholder.getAttribute("data-placeholder-pending")).toBeNull();
    await noJs.locator('[data-gallery-next-link="true"]').click();
    await expect(noJs).toHaveURL(new RegExp(`${PAGE_TWO_PATH.replaceAll("/", "\\/")}$`));
    await expect(noJs.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
  } finally {
    await context.close();
  }
});
