import { expect, test, type Page } from "@playwright/test";
import { stubImageRequests } from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const PAGE_THREE_PATH = `${FIXTURE_PATH}/page/3`;
const CARD_SELECTOR = '[data-gallery-grid="true"] > li[data-photo-id]';
const LINK_SELECTOR = '[data-gallery-next-link="true"]';
const LOADING_TILE_SELECTOR = '[data-gallery-grid="true"] > li[data-gallery-loading-tile="true"]';
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

async function startBottomPin(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as typeof window & { __e2ePinGalleryBottom?: boolean };
    state.__e2ePinGalleryBottom = true;
    const pin = (): void => {
      if (!state.__e2ePinGalleryBottom) return;
      window.scrollTo(0, document.documentElement.scrollHeight);
      requestAnimationFrame(pin);
    };
    pin();
  });
}

async function stopBottomPin(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as typeof window & { __e2ePinGalleryBottom?: boolean }).__e2ePinGalleryBottom = false;
  });
}

async function observerGeometry(page: Page) {
  return page.evaluate(({ linkSelector, sentinelSelector }) => {
    const link = document.querySelector(linkSelector);
    const nav = link?.closest<HTMLElement>("[data-gallery-feed-next]");
    const sentinel = document.querySelector(sentinelSelector);
    const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
    const sentinelRect = sentinel?.getBoundingClientRect();
    return {
      linkHidden: Boolean(nav && getComputedStyle(nav).display === "none"),
      sentinelInsideObserverRange: (sentinelRect?.top ?? Number.POSITIVE_INFINITY) <= window.innerHeight + 240
        && (sentinelRect?.bottom ?? Number.NEGATIVE_INFINITY) >= 0,
      gridNextIsSentinel: Boolean(grid && grid.nextElementSibling === sentinel),
      loadingTailCount: grid?.querySelectorAll('[data-gallery-loading-tile="true"]').length ?? 0,
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
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(24);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(1);

  try {
    await jumpPastCurrentLink(page);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkHidden: true,
      sentinelInsideObserverRange: true,
      gridNextIsSentinel: true,
      loadingTailCount: 24,
    });
    // Continued downward input can arrive while the request is in flight and
    // the browser keeps the bottom sentinel intersecting. It must queue one
    // subsequent batch without requiring a synthetic leave/re-enter cycle.
    await page.mouse.wheel(0, 2_000);
    pageTwo.release();
    await expect.poll(() => pageThreeRequests).toBe(1);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 2 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkHidden: true,
      sentinelInsideObserverRange: true,
      gridNextIsSentinel: true,
      loadingTailCount: 2,
    });
  } finally {
    pageTwo.release();
    pageThree.release();
  }

  await expect(page.locator(CARD_SELECTOR)).toHaveCount(50);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("All photos loaded");
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(0);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(0);
  await expect(page.locator('[data-gallery-feed-next]')).toHaveCount(0);
});

test("restarts a disarmed loader when the sentinel stayed visible across append @smoke", async ({ page }) => {
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

  await page.goto(`${FIXTURE_PATH}?gallery-bottom-pin=1`);
  await expect(page.locator(CARD_SELECTOR)).toHaveCount(24);
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(24);

  try {
    await jumpPastCurrentLink(page);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    await startBottomPin(page);
    pageTwo.release();
    await expect(page.locator(CARD_SELECTOR)).toHaveCount(48);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loaded 24 photos.");
    await expect(observerGeometry(page)).resolves.toMatchObject({
      sentinelInsideObserverRange: true,
      gridNextIsSentinel: true,
      loadingTailCount: 2,
    });
    expect(pageThreeRequests).toBe(0);

    await stopBottomPin(page);
    await page.mouse.wheel(0, 2_000);
    await expect.poll(() => pageThreeRequests).toBe(1);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 2 photos…");
  } finally {
    await stopBottomPin(page);
    pageTwo.release();
    pageThree.release();
  }

  await expect(page.locator(CARD_SELECTOR)).toHaveCount(50);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("All photos loaded");
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(0);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(0);
  await expect(page.locator('[data-gallery-feed-next]')).toHaveCount(0);
});
