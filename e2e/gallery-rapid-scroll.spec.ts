import { expect, test, type Page } from "@playwright/test";
import { stubImageRequests } from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const PAGE_THREE_PATH = `${FIXTURE_PATH}/page/3`;
const CARD_SELECTOR = '[data-gallery-grid="true"] > li[data-photo-id]';
const LINK_SELECTOR = '[data-gallery-next-link="true"]';
const LOADING_FIELD_SELECTOR = '[data-gallery-loading-field="true"]';
const AUTO_LOAD_SENTINEL_SELECTOR = '[data-gallery-auto-load-sentinel="true"]';
const STATUS_SELECTOR = '[data-gallery-status="true"]';

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
});

function delayedResponse() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, released };
}

async function jumpPastCurrentLink(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
}

async function observerGeometry(page: Page) {
  return page.evaluate(({ linkSelector, sentinelSelector }) => {
    const link = document.querySelector(linkSelector);
    const sentinel = document.querySelector(sentinelSelector);
    const linkRect = link?.getBoundingClientRect();
    const sentinelRect = sentinel?.getBoundingClientRect();
    return {
      linkPassedAboveViewport: (linkRect?.bottom ?? Number.POSITIVE_INFINITY) < 0,
      sentinelInsideObserverRange: (sentinelRect?.top ?? Number.POSITIVE_INFINITY) <= window.innerHeight + 240
        && (sentinelRect?.bottom ?? Number.NEGATIVE_INFINITY) >= 0,
    };
  }, { linkSelector: LINK_SELECTOR, sentinelSelector: AUTO_LOAD_SENTINEL_SELECTOR });
}

test("loads every batch after rapid scrolling passes the short pagination link @smoke", async ({ page }) => {
  const pageTwo = delayedResponse();
  const pageThree = delayedResponse();
  let pageThreeRequests = 0;
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    await pageTwo.released;
    await route.continue();
  });
  await page.route(`**${PAGE_THREE_PATH}`, async (route) => {
    pageThreeRequests += 1;
    await pageThree.released;
    await route.continue();
  });

  await page.goto(`${FIXTURE_PATH}?gallery-rapid-scroll=1`);
  await expect(page.locator(CARD_SELECTOR)).toHaveCount(24);
  await expect(page.locator(LOADING_FIELD_SELECTOR)).toHaveCount(1);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(1);

  try {
    await jumpPastCurrentLink(page);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkPassedAboveViewport: true,
      sentinelInsideObserverRange: true,
    });
    // Continued downward input can arrive while the request is in flight and
    // the browser keeps the bottom sentinel intersecting. It must queue one
    // subsequent batch without requiring a synthetic leave/re-enter cycle.
    await page.mouse.wheel(0, 2_000);
    pageTwo.release();
    await expect.poll(() => pageThreeRequests).toBe(1);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 2 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkPassedAboveViewport: false,
      sentinelInsideObserverRange: true,
    });
  } finally {
    pageTwo.release();
    pageThree.release();
  }

  await expect(page.locator(CARD_SELECTOR)).toHaveCount(50);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("All photos loaded");
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(0);
});
