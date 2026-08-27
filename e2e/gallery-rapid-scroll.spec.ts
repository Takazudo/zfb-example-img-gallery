import { expect, test } from "@playwright/test";
import { stubImageRequests } from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const CARD_SELECTOR = '[data-gallery-grid="true"] > li[data-photo-id]';
const LINK_SELECTOR = '[data-gallery-next-link="true"]';
const LOADING_FIELD_SELECTOR = '[data-gallery-loading-field="true"]';
const AUTO_LOAD_SENTINEL_SELECTOR = '[data-gallery-auto-load-sentinel="true"]';
const STATUS_SELECTOR = '[data-gallery-status="true"]';

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
});

test("loads after one rapid scroll passes the short pagination link @smoke", async ({ page }) => {
  let releasePageTwo!: () => void;
  const pageTwoReleased = new Promise<void>((resolve) => {
    releasePageTwo = resolve;
  });
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    await pageTwoReleased;
    await route.continue();
  });

  await page.goto(`${FIXTURE_PATH}?gallery-rapid-scroll=1`);
  await expect(page.locator(CARD_SELECTOR)).toHaveCount(24);
  await expect(page.locator(LOADING_FIELD_SELECTOR)).toHaveCount(1);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(1);

  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      window.scrollTo(0, document.documentElement.scrollHeight);
    });

    await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
    const rapidScrollState = await page.evaluate(({ linkSelector, sentinelSelector }) => {
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
    expect(rapidScrollState).toEqual({
      linkPassedAboveViewport: true,
      sentinelInsideObserverRange: true,
    });
  } finally {
    releasePageTwo();
  }

  await expect(page.locator(CARD_SELECTOR)).toHaveCount(48);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loaded 24 photos.");
});
