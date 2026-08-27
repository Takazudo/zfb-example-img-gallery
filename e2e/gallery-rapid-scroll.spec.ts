import { expect, test, type Page } from "@playwright/test";
import { stubImageRequests } from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const PAGE_THREE_PATH = `${FIXTURE_PATH}/page/3`;
const CARD_SELECTOR = '[data-gallery-grid="true"] > li[data-photo-id]';
const LINK_SELECTOR = '[data-gallery-next-link="true"]';
const LOADING_TILE_SELECTOR = '[data-gallery-grid="true"] > li[data-gallery-loading-tile="true"]';
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
  return page.evaluate(({ linkSelector, tileSelector }) => {
    const link = document.querySelector(linkSelector);
    const nav = link?.closest<HTMLElement>("[data-gallery-feed-next]");
    const tile = document.querySelector<HTMLElement>(tileSelector);
    const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
    const tileRect = tile?.getBoundingClientRect();
    return {
      linkHidden: Boolean(nav && getComputedStyle(nav).display === "none"),
      loaderInsideObserverRange: (tileRect?.top ?? Number.POSITIVE_INFINITY) <= window.innerHeight
        && (tileRect?.bottom ?? Number.NEGATIVE_INFINITY) >= 0,
      loaderIsGridTail: Boolean(grid && grid.lastElementChild === tile),
      loaderActive: tile?.dataset.galleryLoadingActive === "true",
      loadingTileCount: grid?.querySelectorAll('[data-gallery-loading-tile="true"]').length ?? 0,
    };
  }, { linkSelector: LINK_SELECTOR, tileSelector: LOADING_TILE_SELECTOR });
}

test("loads each batch only when its moved tail tile enters view @smoke", async ({ page }) => {
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
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(1);

  try {
    await jumpPastCurrentLink(page);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkHidden: true,
      loaderInsideObserverRange: true,
      loaderIsGridTail: true,
      loaderActive: true,
      loadingTileCount: 1,
    });
    // Input against the consumed tile must not start the next batch after its
    // replacement moves below the viewport.
    await page.mouse.wheel(0, 2_000);
    pageTwo.release();
    await expect(page.locator(CARD_SELECTOR)).toHaveCount(48);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loaded 24 photos.");
    expect(pageThreeRequests).toBe(0);
    await expect(observerGeometry(page)).resolves.toEqual({
      linkHidden: true,
      loaderInsideObserverRange: false,
      loaderIsGridTail: true,
      loaderActive: false,
      loadingTileCount: 1,
    });

    // Reaching the moved tile produces the next leave/re-enter observer cycle.
    await jumpPastCurrentLink(page);
    await expect.poll(() => pageThreeRequests).toBe(1);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 2 photos…");
    await expect(observerGeometry(page)).resolves.toEqual({
      linkHidden: true,
      loaderInsideObserverRange: true,
      loaderIsGridTail: true,
      loaderActive: true,
      loadingTileCount: 1,
    });
  } finally {
    pageTwo.release();
    pageThree.release();
  }

  await expect(page.locator(CARD_SELECTOR)).toHaveCount(50);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("All photos loaded");
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(0);
  await expect(page.locator('[data-gallery-feed-next]')).toHaveCount(0);
});

test("restarts a disarmed loader when the new tail tile stays visible after append @smoke", async ({ page }) => {
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
  await expect(page.locator(LOADING_TILE_SELECTOR)).toHaveCount(1);

  try {
    await jumpPastCurrentLink(page);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    await startBottomPin(page);
    pageTwo.release();
    await expect(page.locator(CARD_SELECTOR)).toHaveCount(48);
    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loaded 24 photos.");
    await expect(observerGeometry(page)).resolves.toMatchObject({
      loaderInsideObserverRange: true,
      loaderIsGridTail: true,
      loaderActive: false,
      loadingTileCount: 1,
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
  await expect(page.locator('[data-gallery-feed-next]')).toHaveCount(0);
});
