import { expect, test, type Page } from "@playwright/test";
import {
  installIntersectionObserverStub,
  stubImageRequests,
  triggerIntersection,
} from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const FEED_SELECTOR = '[data-gallery-feed="true"]';
const MAIN_GRID_SELECTOR = `${FEED_SELECTOR} > [data-gallery-grid="true"]`;
const CARD_SELECTOR = `${MAIN_GRID_SELECTOR} > li[data-photo-id]`;
const LOADING_FIELD_SELECTOR = '[data-gallery-loading-field="true"]';

type Layout = "uniform" | "spotlight";

function cards(page: Page) {
  return page.locator(CARD_SELECTOR);
}

function nextLink(page: Page) {
  return page.locator('[data-gallery-next-link="true"]');
}

function loadingField(page: Page) {
  return page.locator(LOADING_FIELD_SELECTOR);
}

async function openGallery(page: Page, identity: string): Promise<void> {
  await page.goto(`${FIXTURE_PATH}?gallery-append-reveal=${identity}`);
  await expect(cards(page)).toHaveCount(24);
  await expect(loadingField(page)).toHaveCount(1);
  // Wait for the display-settings island to finish its default preference
  // setup before tests override the root layout attribute directly.
  await expect(page.getByRole("button", { name: "Display settings", exact: true })).toBeVisible();
}

async function setLayout(page: Page, layout: Layout): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-gallery-layout", value);
  }, layout);
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", layout);
}

async function cardBoxes(page: Page) {
  return cards(page).evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.getAttribute("data-photo-id") ?? "",
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }));
}

async function fieldState(page: Page) {
  return loadingField(page).evaluate((field) => {
    const rect = field.getBoundingClientRect();
    const tiles = [...field.querySelectorAll<HTMLElement>(":scope > .photo-grid > li.photo-card")];
    const feed = field.closest<HTMLElement>('[data-gallery-feed="true"]');
    return {
      height: rect.height,
      width: rect.width,
      tileCount: tiles.length,
      tileClasses: tiles.map((tile) => tile.className),
      tileHeights: tiles.map((tile) => (
        tile.querySelector<HTMLElement>(".photo-card-skeleton-fill")?.getBoundingClientRect().height ?? 0
      )),
      isFeedLastChild: feed?.lastElementChild === field,
      fieldInsideMainGrid: Boolean(field.closest('[data-gallery-grid="true"]')),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
  await installIntersectionObserverStub(page);
});

test("reserves the next batch in uniform and spotlight layouts without moving existing cards @smoke", async ({ page }) => {
  // Reduced motion removes reveal transforms from the measurement, so this is
  // a layout assertion rather than a measurement of an in-flight animation.
  await page.emulateMedia({ reducedMotion: "reduce" });

  for (const [layout, identity] of [["uniform", "uniform"], ["spotlight", "spotlight"]] as const) {
    await openGallery(page, identity);
    await setLayout(page, layout);

    const beforeCards = await cardBoxes(page);
    const beforeGridHeight = await page.locator(MAIN_GRID_SELECTOR).evaluate((grid) => grid.getBoundingClientRect().height);
    const beforeField = await fieldState(page);
    const expectedCount = Number(await nextLink(page).getAttribute("data-gallery-next-count"));

    expect(beforeField.isFeedLastChild).toBe(true);
    expect(beforeField.fieldInsideMainGrid).toBe(false);
    expect(beforeField.tileCount).toBe(expectedCount);
    expect(beforeField.tileCount).toBe(24);
    expect(beforeField.tileClasses.every((className) => className.startsWith("photo-card "))).toBe(true);

    await triggerIntersection(page, true);
    await expect(cards(page)).toHaveCount(48);
    const afterCards = await cardBoxes(page);
    const afterGridHeight = await page.locator(MAIN_GRID_SELECTOR).evaluate((grid) => grid.getBoundingClientRect().height);
    const afterField = await fieldState(page);
    const appendedClasses = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => element.className));

    // The field's metadata-derived role order must be the same order that the
    // server-authored next page uses when those tiles become real cards.
    expect(appendedClasses).toEqual(beforeField.tileClasses);
    expect(afterField.isFeedLastChild).toBe(true);
    expect(afterField.fieldInsideMainGrid).toBe(false);
    expect(afterField.tileCount).toBe(Number(await nextLink(page).getAttribute("data-gallery-next-count")));

    const beforeById = new Map(beforeCards.map((card) => [card.id, card]));
    for (const card of afterCards.slice(0, beforeCards.length)) {
      const previous = beforeById.get(card.id);
      expect(previous).toBeDefined();
      expect(Math.abs(card.left - previous!.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(card.top - previous!.top)).toBeLessThanOrEqual(2);
      expect(Math.abs(card.right - previous!.right)).toBeLessThanOrEqual(2);
      expect(Math.abs(card.bottom - previous!.bottom)).toBeLessThanOrEqual(2);
    }

    const gridGrowth = afterGridHeight - beforeGridHeight;
    expect(gridGrowth).toBeGreaterThan(0);
    expect(beforeField.height).toBeGreaterThan(0);
    expect(Math.abs(beforeField.height - gridGrowth) / gridGrowth).toBeLessThanOrEqual(0.15);
  }
});

test("staggered appended cards expose increasing delays and non-uniform mid-reveal opacity @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openGallery(page, "reveal");

  await nextLink(page).click();
  await expect(cards(page)).toHaveCount(48);

  // Sample each card's own Web Animation rather than the skeleton pulse in the
  // separate loading field. Setting one shared currentTime makes the opacity
  // comparison deterministic even though the browser clock keeps advancing.
  const samples = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => {
    const animation = element.getAnimations().find((candidate) => (
      Number(candidate.effect?.getTiming().duration) === 280
    ));
    if (!animation) return { delay: Number.NaN, opacity: Number.NaN };
    const delay = Number(animation.effect?.getTiming().delay ?? Number.NaN);
    animation.pause();
    animation.currentTime = 210;
    return { delay, opacity: Number(getComputedStyle(element).opacity) };
  }));
  const delays = samples.map((sample) => sample.delay);
  const opacities = samples.map((sample) => sample.opacity);

  expect(samples).toHaveLength(24);
  expect(delays.every((delay, index) => (
    Number.isFinite(delay) && (index === 0 || delay > delays[index - 1]!)
  ))).toBe(true);
  expect(new Set(delays.map((delay) => delay.toFixed(4))).size).toBe(delays.length);
  expect(delays[0]).toBe(0);
  expect(delays.at(-1)).toBeGreaterThan(delays[0]!);
  expect(opacities.every((opacity) => Number.isFinite(opacity))).toBe(true);
  expect(new Set(opacities.map((opacity) => opacity.toFixed(3))).size).toBeGreaterThan(1);
});

test("keeps Original loading tiles, reduced-motion cards, terminal removal, and grid purity @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openGallery(page, "reduced-original");
  await page.evaluate(() => document.documentElement.setAttribute("data-thumb-ratio", "original"));
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "original");

  const initial = await fieldState(page);
  expect(initial.tileCount).toBe(24);
  expect(initial.tileHeights.every((height) => height > 0)).toBe(true);

  await nextLink(page).click();
  await expect(cards(page)).toHaveCount(48);
  await expect(loadingField(page)).toHaveCount(1);
  await expect(loadingField(page).locator(":scope > .photo-grid > li.photo-card")).toHaveCount(2);
  await expect(nextLink(page)).toHaveText("Load next 2 photos");
  const remainder = await fieldState(page);
  expect(remainder.tileHeights.every((height) => height > 0)).toBe(true);

  const appendedBeforeTerminal = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => ({
    opacity: Number(getComputedStyle(element).opacity),
    animations: element.getAnimations().length,
  })));
  expect(appendedBeforeTerminal.every(({ opacity, animations }) => opacity === 1 && animations === 0)).toBe(true);

  await nextLink(page).click();
  await expect(cards(page)).toHaveCount(50);
  await expect(loadingField(page)).toHaveCount(0);
  await expect(nextLink(page)).toHaveText("All photos loaded");

  const gridPurity = await page.locator(MAIN_GRID_SELECTOR).evaluate((grid) => {
    const children = [...grid.children];
    return {
      directChildren: children.filter((child) => child instanceof HTMLElement && child.dataset.photoId !== undefined).length,
      allChildren: children.length,
      directOnly: children.every((child) => child.tagName === "LI" && child instanceof HTMLElement && child.dataset.photoId !== undefined),
    };
  });
  expect(gridPurity).toEqual({ directChildren: 50, allChildren: 50, directOnly: true });
});
