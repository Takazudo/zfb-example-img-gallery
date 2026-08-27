import { expect, test, type Page } from "@playwright/test";
import {
  installIntersectionObserverStub,
  stubImageRequests,
  triggerIntersection,
} from "./fixtures";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const MAIN_GRID_SELECTOR = '[data-gallery-feed="true"] > [data-gallery-grid="true"]';
const CARD_SELECTOR = `${MAIN_GRID_SELECTOR} > li[data-photo-id]`;
const TILE_SELECTOR = `${MAIN_GRID_SELECTOR} > li[data-gallery-loading-tile="true"]`;
const FEED_NEXT_SELECTOR = '[data-gallery-feed-next]';
const AUTO_LOAD_SENTINEL_SELECTOR = '[data-gallery-auto-load-sentinel="true"]';
const STATUS_SELECTOR = '[data-gallery-status="true"]';

type Layout = "uniform" | "spotlight" | "editorial" | "justified" | "masonry";

function cards(page: Page) {
  return page.locator(CARD_SELECTOR);
}

function loadingTiles(page: Page) {
  return page.locator(TILE_SELECTOR);
}

async function openHealthyGallery(page: Page, identity: string): Promise<void> {
  await page.goto(`${FIXTURE_PATH}?gallery-append-reveal=${identity}`);
  await expect(cards(page)).toHaveCount(24);
  await expect(loadingTiles(page)).toHaveCount(24);
  await expect(page.locator(MAIN_GRID_SELECTOR)).toHaveCount(1);
  await expect(page.locator(`[data-gallery-feed="true"] > ${FEED_NEXT_SELECTOR}`)).toHaveCount(1);
  await expect(page.locator(`[data-gallery-feed="true"] > ${FEED_NEXT_SELECTOR}`)).toBeHidden();
  // Wait for the display-settings island to finish its default preference
  // setup before tests override root layout or width attributes directly.
  await expect(page.getByRole("button", { name: "Display settings", exact: true })).toBeVisible();
}

async function setLayout(page: Page, layout: Layout): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.setAttribute("data-gallery-layout", value);
  }, layout);
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", layout);
}

async function cardBoxes(page: Page, selector = CARD_SELECTOR) {
  return page.locator(selector).evaluateAll((elements) => elements.map((element) => {
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

async function gridState(page: Page) {
  return page.evaluate(({ gridSelector, feedSelector, tileSelector }) => {
    const feed = document.querySelector<HTMLElement>(feedSelector);
    const grid = document.querySelector<HTMLElement>(gridSelector);
    const children = grid ? [...grid.children] : [];
    const realCards = children.filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.dataset.photoId !== undefined
    ));
    const tiles = children.filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.matches(tileSelector)
    ));
    const sentinel = feed?.querySelector<HTMLElement>('[data-gallery-auto-load-sentinel="true"]') ?? null;
    const next = feed?.querySelector<HTMLElement>("[data-gallery-feed-next]") ?? null;
    const status = feed?.querySelector<HTMLElement>("[data-gallery-status]") ?? null;
    return {
      directChildren: children.length,
      realIds: realCards.map((card) => card.dataset.photoId ?? ""),
      tileCount: tiles.length,
      tileClasses: tiles.map((tile) => tile.className),
      tileAnimationNames: tiles.map((tile) => {
        const fill = tile.querySelector<HTMLElement>(".photo-card-skeleton-fill");
        return fill ? getComputedStyle(fill).animationName : "";
      }),
      firstTileIndex: tiles.length > 0 ? children.indexOf(tiles[0]!) : -1,
      directOnly: children.every((child) => child.tagName === "LI" && child instanceof HTMLElement),
      nestedGridCount: grid?.querySelectorAll('[data-gallery-grid="true"]').length ?? 0,
      gridNextIsSentinel: Boolean(grid && grid.nextElementSibling === sentinel),
      sentinelCount: feed?.querySelectorAll('[data-gallery-auto-load-sentinel="true"]').length ?? 0,
      navInsideGrid: Boolean(grid?.querySelector("[data-gallery-feed-next]")),
      statusInsideGrid: Boolean(grid?.querySelector("[data-gallery-status]")),
      navOutsideGrid: Boolean(next && next.closest('[data-gallery-grid="true"]') === null),
      statusOutsideGrid: Boolean(status && status.closest('[data-gallery-grid="true"]') === null),
    };
  }, {
    gridSelector: MAIN_GRID_SELECTOR,
    feedSelector: '[data-gallery-feed="true"]',
    tileSelector: '[data-gallery-loading-tile="true"]',
  });
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

test("keeps existing boxes stable while delayed observer append replaces the direct loading tail @smoke", async ({ page }) => {
  const pageTwo = delayedResponse();
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    await pageTwo.released;
    await route.continue();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await openHealthyGallery(page, "delayed");
  await setLayout(page, "uniform");
  await page.evaluate(() => document.documentElement.setAttribute("data-thumb-width", "large"));

  const beforeState = await gridState(page);
  const beforeCards = await cardBoxes(page);
  const reservedBoxes = await cardBoxes(page, TILE_SELECTOR);
  expect(beforeState).toMatchObject({
    directChildren: 48,
    realIds: expect.any(Array),
    tileCount: 24,
    firstTileIndex: 24,
    directOnly: true,
    nestedGridCount: 0,
    gridNextIsSentinel: true,
    sentinelCount: 1,
    navInsideGrid: false,
    statusInsideGrid: false,
    navOutsideGrid: true,
    statusOutsideGrid: true,
  });
  expect(beforeState.realIds).toHaveLength(24);
  expect(beforeState.tileClasses.every((className) => className.startsWith("photo-card "))).toBe(true);

  await triggerIntersection(page, true);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loading 24 photos…");
  pageTwo.release();
  await expect(cards(page)).toHaveCount(48);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("Loaded 24 photos.");

  const afterState = await gridState(page);
  const afterCards = await cardBoxes(page);
  const appendedBoxes = afterCards.slice(24);
  const afterTailBoxes = await cardBoxes(page, TILE_SELECTOR);
  const appendedClasses = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => element.className));

  // The incoming cards consume the exact reserved rectangles. Existing cards
  // therefore keep their boxes while the old tile nodes disappear.
  expect(afterState).toMatchObject({
    directChildren: 50,
    tileCount: 2,
    firstTileIndex: 48,
    directOnly: true,
    nestedGridCount: 0,
    gridNextIsSentinel: true,
    sentinelCount: 1,
    navInsideGrid: false,
    statusInsideGrid: false,
  });
  expect(appendedClasses).toEqual(beforeState.tileClasses);
  expect(afterState.tileClasses).not.toEqual(beforeState.tileClasses);
  expect(afterState.realIds.slice(0, 24)).toEqual(beforeState.realIds);
  expect(afterState.realIds).toHaveLength(48);
  expect(afterTailBoxes).toHaveLength(2);
  for (const [index, card] of beforeCards.entries()) {
    const after = afterCards[index]!;
    expect(Math.abs(card.left - after.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.top - after.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.right - after.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(card.bottom - after.bottom)).toBeLessThanOrEqual(2);
  }
  for (const [index, reserved] of reservedBoxes.entries()) {
    const appended = appendedBoxes[index]!;
    expect(Math.abs(reserved.left - appended.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(reserved.top - appended.top)).toBeLessThanOrEqual(2);
    expect(Math.abs(reserved.right - appended.right)).toBeLessThanOrEqual(2);
    expect(Math.abs(reserved.bottom - appended.bottom)).toBeLessThanOrEqual(2);
  }
});

test("places the sixth card and direct skeleton tail across five columns without a blank band @smoke", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await openHealthyGallery(page, "five-column");
  await setLayout(page, "uniform");
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-thumb-width", "large");
    const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
    if (!grid) throw new Error("gallery grid missing");
    [...grid.querySelectorAll<HTMLElement>(":scope > li[data-photo-id]")].slice(6).forEach((card) => card.remove());
    [...grid.querySelectorAll<HTMLElement>(':scope > li[data-gallery-loading-tile="true"]')].slice(6).forEach((tile) => tile.remove());
  });

  const geometry = await page.evaluate(() => {
    const grid = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
    if (!grid) throw new Error("gallery grid missing");
    const items = [...grid.children] as HTMLElement[];
    const real = items.filter((item) => item.dataset.photoId !== undefined);
    const tiles = items.filter((item) => item.dataset.galleryLoadingTile === "true");
    const rects = (elements: HTMLElement[]) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    });
    const realRects = rects(real);
    const tileRects = rects(tiles);
    const style = getComputedStyle(grid);
    const firstRowTop = realRects[0]?.top ?? 0;
    const sixthTop = realRects[5]?.top ?? 0;
    const tolerance = 1;
    return {
      columns: realRects.filter((rect) => Math.abs(rect.top - firstRowTop) <= tolerance).length,
      sixthStartsSecondRow: sixthTop > firstRowTop,
      firstFourTilesShareSixthRow: tileRects.slice(0, 4).every((rect) => Math.abs(rect.top - sixthTop) <= tolerance),
      nextTilesStartNextRow: (tileRects[4]?.top ?? 0) > sixthTop,
      gap: Number.parseFloat(style.columnGap),
      rowGap: Number.parseFloat(style.rowGap),
      firstRowGap: (realRects[1]?.left ?? 0) - (realRects[0]?.right ?? 0),
      sixthToFirstTileGap: (tileRects[0]?.left ?? 0) - (realRects[5]?.right ?? 0),
      sixthBottom: realRects[5]?.bottom ?? 0,
      nextTileTop: tileRects[4]?.top ?? 0,
      directItemCount: items.length,
      realCount: real.length,
      tileCount: tiles.length,
    };
  });

  expect(geometry).toMatchObject({
    columns: 5,
    sixthStartsSecondRow: true,
    firstFourTilesShareSixthRow: true,
    nextTilesStartNextRow: true,
    directItemCount: 12,
    realCount: 6,
    tileCount: 6,
  });
  expect(Math.abs(geometry.firstRowGap - geometry.gap)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.sixthToFirstTileGap - geometry.gap)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.nextTileTop - (geometry.sixthBottom + geometry.rowGap))).toBeLessThanOrEqual(2);
});

test("preserves metadata-derived order through patterned layouts and responsive widths @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cases: readonly [number, Layout, string][] = [
    [1200, "spotlight", "spotlight-wide"],
    [800, "editorial", "editorial-mid"],
    [375, "justified", "justified-narrow"],
    [1200, "masonry", "masonry-wide"],
  ];

  for (const [width, layout, identity] of cases) {
    await page.setViewportSize({ width, height: 900 });
    await openHealthyGallery(page, identity);
    await setLayout(page, layout);
    const before = await gridState(page);
    const initialIds = before.realIds;
    const reservedClasses = before.tileClasses;
    expect(before.tileCount).toBe(24);
    expect(before.firstTileIndex).toBe(24);
    expect(before.gridNextIsSentinel).toBe(true);
    expect(before.directOnly).toBe(true);

    await triggerIntersection(page, true);
    await expect(cards(page)).toHaveCount(48);
    const after = await gridState(page);
    const appendedClasses = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => element.className));
    expect(after.realIds.slice(0, 24)).toEqual(initialIds);
    expect(appendedClasses).toEqual(reservedClasses);
    expect(after.tileCount).toBe(2);
    expect(after.firstTileIndex).toBe(48);
    expect(after.gridNextIsSentinel).toBe(true);
    expect(after.navInsideGrid).toBe(false);
    expect(after.statusInsideGrid).toBe(false);
    expect(after.directOnly).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  }
});

test("staggered appended cards expose increasing delays and non-uniform mid-reveal opacity @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openHealthyGallery(page, "reveal");

  await triggerIntersection(page, true);
  await expect(cards(page)).toHaveCount(48);

  // Sample each card's own Web Animation rather than the skeleton pulse in the
  // active grid tail. Setting one shared currentTime makes the opacity
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

test("keeps reduced-motion cards visible, disables the skeleton pulse, and removes the terminal tail @smoke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openHealthyGallery(page, "reduced-motion");

  const initial = await gridState(page);
  expect(initial.tileCount).toBe(24);
  expect(initial.tileAnimationNames.every((name) => name === "none")).toBe(true);

  await triggerIntersection(page, true);
  await expect(cards(page)).toHaveCount(48);
  const appendedBeforeTerminal = await cards(page).evaluateAll((elements) => elements.slice(24).map((element) => ({
    opacity: Number(getComputedStyle(element).opacity),
    animations: element.getAnimations().length,
  })));
  expect(appendedBeforeTerminal.every(({ opacity, animations }) => opacity === 1 && animations === 0)).toBe(true);

  await triggerIntersection(page, false);
  await triggerIntersection(page, true);
  await expect(cards(page)).toHaveCount(50);
  await expect(page.locator(TILE_SELECTOR)).toHaveCount(0);
  await expect(page.locator(AUTO_LOAD_SENTINEL_SELECTOR)).toHaveCount(0);
  await expect(page.locator(`[data-gallery-feed="true"] > ${FEED_NEXT_SELECTOR}`)).toHaveCount(0);
  await expect(page.locator(STATUS_SELECTOR)).toHaveText("All photos loaded");

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
