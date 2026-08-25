import { expect, test } from "@playwright/test";
import {
  installIntersectionObserverStub,
  stubImageRequests,
  triggerIntersection,
} from "./fixtures";
import { softClick } from "./navigation";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const PAGE_THREE_PATH = `${FIXTURE_PATH}/page/3`;

function grid(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-grid="true"] > li[data-photo-id]');
}

function nextLink(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-next-link="true"]');
}

function status(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-status="true"]');
}

function delayedResponse() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
}

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
  await installIntersectionObserverStub(page);
});

test("loads delayed batches, disarms the observer, reaches the remainder, and retries failures @smoke", async ({ page }) => {
  const pageTwo = delayedResponse();
  const pageThree = delayedResponse();
  let pageTwoRequests = 0;
  let pageThreeRequests = 0;

  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    pageTwoRequests += 1;
    await pageTwo.released;
    await route.continue();
  });
  await page.route(`**${PAGE_THREE_PATH}`, async (route) => {
    pageThreeRequests += 1;
    await pageThree.released;
    await route.continue();
  });

  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(nextLink(page)).toHaveText("Load next 24 photos");

  await triggerIntersection(page, true);
  await expect(status(page)).toHaveText("Loading 24 photos…");
  expect(pageTwoRequests).toBe(1);
  pageTwo.release();
  await expect(grid(page)).toHaveCount(48);
  await expect(status(page)).toHaveText("Loaded 24 photos.");
  await expect(nextLink(page)).toHaveText("Load next 2 photos");
  await expect(nextLink(page)).toHaveAttribute("href", PAGE_THREE_PATH);

  // An observer that remains intersecting must not cascade another request
  // after an automatic success. The gate requires a leave/re-enter sample.
  await triggerIntersection(page, true);
  await expect.poll(() => pageTwoRequests).toBe(1);
  await expect(status(page)).toHaveText("Loaded 24 photos.");

  // Manual activation is still independent of the observer gate and exposes
  // the final smaller remainder before the terminal state.
  await nextLink(page).click();
  await expect(status(page)).toHaveText("Loading 2 photos…");
  expect(pageThreeRequests).toBe(1);
  pageThree.release();
  await expect(grid(page)).toHaveCount(50);
  await expect(status(page)).toHaveText("All photos loaded");
  await expect(nextLink(page)).toHaveAttribute("aria-disabled", "true");
  await expect(nextLink(page)).not.toHaveAttribute("href");
});

test("keeps the existing grid and canonical retry link after one non-success response @smoke", async ({ page }) => {
  let requests = 0;
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "fixture failure",
      });
      return;
    }
    await route.continue();
  });

  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  const firstIds = await grid(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-photo-id")));
  const firstHref = await nextLink(page).getAttribute("href");

  await triggerIntersection(page, true);
  await expect(status(page)).toContainText("Could not load photos");
  expect(await grid(page).count()).toBe(24);
  expect(await grid(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-photo-id")))).toEqual(firstIds);
  expect(await nextLink(page).getAttribute("href")).toBe(firstHref);
  await expect(nextLink(page)).toContainText("Load next 24 photos");

  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);
  expect(requests).toBe(2);
  await expect(status(page)).toHaveText("Loaded 24 photos.");
});

test("restores two loaded batches through a router photo click and Back without a reload @smoke", async ({ page }) => {
  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);

  const target = grid(page).nth(35).locator('[data-photo-card-media-wrapper] > a.photo-card-link');
  const targetHref = await target.getAttribute("href");
  const before = await page.evaluate((href) => {
    const anchor = document.querySelector(`a[href="${href}"]`);
    return {
      scrollY: window.scrollY,
      top: anchor?.getBoundingClientRect().top ?? null,
    };
  }, targetHref);
  expect(targetHref).toMatch(/^\/photos\/\d+$/);
  expect(before.top).not.toBeNull();
  await page.evaluate(() => {
    (window as typeof window & { __e2eNoReload?: string }).__e2eNoReload = "alive";
  });

  const swap = await softClick(page, targetHref!);
  expect(new URL(swap.finalUrl).pathname).toMatch(/^\/photos\/\d+$/);
  await expect(page.locator("h1")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PATH.replaceAll("/", "\\/")}$`));
  await expect(grid(page)).toHaveCount(48);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __e2eNoReload?: string }
  ).__e2eNoReload ?? null)).toBe("alive");
  await expect(page.locator(
    `[data-gallery-grid="true"] [data-photo-card-media-wrapper] > a[href="${targetHref}"]`,
  )).toBeVisible();

  const after = await page.evaluate((href) => {
    const anchor = document.querySelector(`a[href="${href}"]`);
    return {
      scrollY: window.scrollY,
      top: anchor?.getBoundingClientRect().top ?? null,
    };
  }, targetHref);
  expect(after.top).not.toBeNull();
  expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThan(240);
  expect(Math.abs(after.top! - before.top!)).toBeLessThan(240);
});

test("keeps the canonical next link with JavaScript disabled @smoke", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8788",
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await stubImageRequests(page);
    await page.goto(FIXTURE_PATH);
    await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
    const link = page.locator('[data-gallery-next-link="true"]');
    await expect(link).toHaveAttribute("href", PAGE_TWO_PATH);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${PAGE_TWO_PATH.replaceAll("/", "\\/")}$`));
    await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
    await expect(page.locator("h1")).toContainText("#e2e-fixture");
  } finally {
    await context.close();
  }
});

test("keeps manual loading available when IntersectionObserver is absent @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "IntersectionObserver");
  });
  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(nextLink(page)).toBeVisible();
  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PATH.replaceAll("/", "\\/")}$`));
  await expect(status(page)).toHaveText("Loaded 24 photos.");
});
