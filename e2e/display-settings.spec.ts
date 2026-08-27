import { expect, test } from "@playwright/test";
import {
  pngWithDimensions,
  stubImageRequests,
} from "./fixtures";
import { softClick } from "./navigation";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PREFERENCES_KEY = "stillframe-gallery-preferences";
const LAYOUTS = ["uniform", "spotlight", "editorial", "justified", "masonry"] as const;
type LayoutMode = typeof LAYOUTS[number];

function ratioInput(page: import("@playwright/test").Page, value: string) {
  return page.locator(`input[name="thumbnail-ratio"][value="${value}"]`);
}

function widthInput(page: import("@playwright/test").Page, value: string) {
  return page.locator(`input[name="thumbnail-width"][value="${value}"]`);
}

function layoutInput(page: import("@playwright/test").Page, value: LayoutMode) {
  return page.locator(`input[name="gallery-layout"][value="${value}"]`);
}

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Display settings", exact: true });
  if (!(await trigger.isVisible())) {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
  }
  await trigger.click();
}

async function assertSettingsAvailability(
  page: import("@playwright/test").Page,
  mode: LayoutMode,
): Promise<void> {
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  const ratioGroup = dialog.getByRole("group", { name: "Thumbnail ratio", exact: true });
  const widthGroup = dialog.getByRole("group", { name: "Thumbnail width", exact: true });
  const expectsRatio = mode === "uniform";
  const expectsWidth = mode === "uniform" || mode === "masonry";

  if (expectsRatio) await expect(ratioGroup).toBeVisible();
  else await expect(ratioGroup).toHaveCount(0);
  if (expectsWidth) await expect(widthGroup).toBeVisible();
  else await expect(widthGroup).toHaveCount(0);

  const description = dialog.locator("#gallery-layout-description");
  if (mode === "uniform") {
    await expect(description).toHaveText("Adjust thumbnail ratio and width below.");
  } else if (mode === "masonry") {
    await expect(description).toContainText("Masonry keeps each photo's original ratio.");
  } else {
    await expect(description).toContainText("manages thumbnail geometry automatically");
  }
}

async function assertLayoutSignature(
  page: import("@playwright/test").Page,
  mode: LayoutMode,
): Promise<void> {
  const signature = await page.locator('[data-gallery-grid="true"]').evaluate((list) => {
    const cards = [...list.querySelectorAll<HTMLElement>(":scope > li[data-photo-id]")];
    return {
      display: getComputedStyle(list).display,
      cards: cards.slice(0, 11).map((card) => {
        const style = getComputedStyle(card);
        const image = card.querySelector<HTMLElement>("img");
        return {
          token: [...card.classList].find((name) => /^g[fs][0-9a]$/.test(name)) ?? "",
          columnStart: style.gridColumnStart,
          columnEnd: style.gridColumnEnd,
          rowStart: style.gridRowStart,
          rowEnd: style.gridRowEnd,
          breakInside: style.breakInside,
          rect: card.getBoundingClientRect().toJSON(),
          imageRect: image?.getBoundingClientRect().toJSON() ?? null,
        };
      }),
    };
  });

  expect(signature.cards).toHaveLength(11);
  if (mode === "uniform") {
    expect(signature.display).toBe("grid");
    expect(signature.cards[0]!.rect.width).toBeCloseTo(signature.cards[1]!.rect.width, 0);
    expect(signature.cards[1]!.rect.width).toBeCloseTo(signature.cards[2]!.rect.width, 0);
  } else if (mode === "spotlight") {
    expect(signature.cards[0]).toMatchObject({
      token: "gf0",
      columnStart: "1",
      columnEnd: "span 2",
      rowStart: "span 2",
      rowEnd: "auto",
    });
    expect(signature.cards[0]!.rect.width).toBeGreaterThan(signature.cards[1]!.rect.width * 1.5);
    expect(signature.cards[0]!.rect.height).toBeGreaterThan(signature.cards[1]!.rect.height * 1.5);
  } else if (mode === "editorial") {
    expect(signature.cards[0]).toMatchObject({ columnStart: "1", columnEnd: "span 2", rowStart: "span 2", rowEnd: "auto" });
    expect(signature.cards[1]).toMatchObject({ columnStart: "3", columnEnd: "span 2", rowStart: "span 1", rowEnd: "auto" });
    expect(signature.cards[4]).toMatchObject({ columnStart: "1", columnEnd: "span 1", rowStart: "span 2", rowEnd: "auto" });
    expect(signature.cards[5]).toMatchObject({ columnStart: "2", columnEnd: "span 1", rowStart: "span 1", rowEnd: "auto" });
    expect(signature.cards[0]!.rect.width).toBeGreaterThan(signature.cards[2]!.rect.width * 1.5);
    expect(signature.cards[4]!.rect.height).toBeGreaterThan(signature.cards[5]!.rect.height * 1.5);
  } else if (mode === "justified") {
    expect(signature.cards.map(({ columnStart, columnEnd }) => [columnStart, columnEnd])).toEqual([
      ["1", "span 5"], ["6", "span 3"], ["9", "span 4"],
      ["1", "span 3"], ["4", "span 6"], ["10", "span 3"],
      ["1", "span 4"], ["5", "span 4"], ["9", "span 4"],
      ["1", "span 7"], ["8", "span 5"],
    ]);
    expect(signature.cards[0]!.rect.width).toBeGreaterThan(signature.cards[1]!.rect.width);
    expect(signature.cards[1]!.rect.width).toBeLessThan(signature.cards[2]!.rect.width);
    expect(signature.cards[0]!.rect.top).toBeCloseTo(signature.cards[2]!.rect.top, 0);
  } else {
    expect(signature.display).toBe("block");
    expect(signature.cards.every(({ breakInside }) => breakInside === "avoid")).toBe(true);
    expect(signature.cards[0]!.imageRect?.height).not.toBeCloseTo(signature.cards[1]!.imageRect?.height ?? 0, 0);
    expect(signature.cards[0]!.rect.left).toBeCloseTo(signature.cards[1]!.rect.left, 0);
    expect(signature.cards[0]!.rect.top).toBeLessThan(signature.cards[1]!.rect.top);
  }
}

async function installMixedIntrinsicImages(page: import("@playwright/test").Page): Promise<void> {
  // Keep the repository's /img/** stub as the default, but return tiny valid
  // PNGs with the fixture's declared dimensions for Original-mode geometry.
  await page.route("**/img/**", async (route) => {
    const match = /([0-9]{2})\.png(?:$|\?)/.exec(route.request().url());
    if (!match) {
      await route.fallback();
      return;
    }
    const sequence = Number(match?.[1] ?? 1);
    const width = sequence % 2 === 0 ? 160 : 240;
    const height = sequence % 2 === 0 ? 240 : 160;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: pngWithDimensions(width, height),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
});

test("supports dialog control, all five immediate layout signatures, Original geometry, and appended cards @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "IntersectionObserver");
  });
  await installMixedIntrinsicImages(page);
  await page.goto(FIXTURE_PATH);
  const trigger = page.getByRole("button", { name: "Display settings", exact: true });
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  await expect(trigger).toBeVisible();

  // Pointer open, keyboard close, and focus restoration.
  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  // Keyboard open and keyboard radio activation.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  const original = ratioInput(page, "original");
  await original.focus();
  await page.keyboard.press("Space");
  await expect(original).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "original");

  for (const value of ["portrait", "square", "landscape", "original"]) {
    await ratioInput(page, value).click();
    await expect(ratioInput(page, value)).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", value);
  }
  for (const value of ["small", "medium", "large"]) {
    await widthInput(page, value).click();
    await expect(widthInput(page, value)).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-thumb-width", value);
  }
  for (const value of LAYOUTS) {
    const idsBefore = await page.locator('[data-gallery-grid="true"] > li[data-photo-id]').evaluateAll(
      (cards) => cards.map((card) => card.getAttribute("data-photo-id")),
    );
    await layoutInput(page, value).click();
    await expect(layoutInput(page, value)).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", value);
    await assertSettingsAvailability(page, value);
    await assertLayoutSignature(page, value);
    expect(await page.locator('[data-gallery-grid="true"] > li[data-photo-id]').evaluateAll(
      (cards) => cards.map((card) => card.getAttribute("data-photo-id")),
    )).toEqual(idsBefore);
  }

  // Original uses each image's intrinsic mixed ratio rather than forcing one
  // crop ratio. The fixture's first two cards intentionally differ.
  await layoutInput(page, "uniform").click();
  await expect(ratioInput(page, "original")).toBeChecked();
  await expect(widthInput(page, "large")).toBeChecked();
  await ratioInput(page, "original").click();
  await widthInput(page, "medium").click();
  const geometry = await page.locator('[data-gallery-grid="true"] img').evaluateAll((images) => images.slice(0, 2).map((image) => {
    const styles = getComputedStyle(image);
    const box = image.getBoundingClientRect();
    return {
      declaredWidth: Number(image.getAttribute("width")),
      declaredHeight: Number(image.getAttribute("height")),
      renderedRatio: box.height / box.width,
      styleRatio: styles.aspectRatio,
      objectFit: styles.objectFit,
    };
  }));
  expect(geometry[0]?.declaredWidth).not.toBe(geometry[1]?.declaredWidth);
  expect(geometry[0]?.declaredHeight).not.toBe(geometry[1]?.declaredHeight);
  expect(geometry[0]?.styleRatio).toContain("auto");
  expect(geometry[0]?.objectFit).toBe("contain");
  expect(geometry[1]?.objectFit).toBe("contain");
  expect(geometry[0]?.renderedRatio).toBeCloseTo(
    (geometry[0]?.declaredHeight ?? 0) / (geometry[0]?.declaredWidth ?? 1),
    1,
  );
  expect(geometry[1]?.renderedRatio).toBeCloseTo(
    (geometry[1]?.declaredHeight ?? 0) / (geometry[1]?.declaredWidth ?? 1),
    1,
  );

  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(trigger).toBeFocused();

  // A setting applied before enhancement also styles cards appended later.
  await trigger.click();
  await ratioInput(page, "landscape").click();
  await widthInput(page, "small").click();
  await layoutInput(page, "editorial").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const next = page.locator('[data-gallery-next-link="true"]');
  await next.click();
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(48);
  const appended = page.locator('[data-gallery-grid="true"] > li[data-photo-id]').nth(47).locator("img");
  await expect(appended).toBeVisible();
  await expect.poll(() => appended.evaluate((image) => {
    const styles = getComputedStyle(image);
    const card = image.closest<HTMLElement>('li[data-photo-id]');
    const cardStyles = card ? getComputedStyle(card) : null;
    return {
      objectFit: styles.objectFit,
      aspectRatio: styles.aspectRatio,
      width: getComputedStyle(document.documentElement).getPropertyValue("--gallery-thumbnail-width").trim(),
      rootLayout: document.documentElement.dataset.galleryLayout,
      columnStart: cardStyles?.gridColumnStart,
      columnEnd: cardStyles?.gridColumnEnd,
    };
  })).toEqual({
    objectFit: "cover",
    aspectRatio: "auto",
    width: "9rem",
    rootLayout: "editorial",
    columnStart: "4",
    columnEnd: "span 1",
  });
});

test("defaults invalid/deleted storage, migrates v1, and persists every layout through reload, tabs, and soft navigation @smoke", async ({ page, context }) => {
  await page.addInitScript((key) => {
    const onceKey = "__e2e-invalid-gallery-preferences-seeded";
    if (sessionStorage.getItem(onceKey) === "1") return;
    localStorage.setItem(key, JSON.stringify({ version: 99, thumbRatio: "portrait", thumbWidth: "large" }));
    sessionStorage.setItem(onceKey, "1");
  }, PREFERENCES_KEY);
  await page.goto(FIXTURE_PATH);
  await expect(ratioInput(page, "square")).toBeChecked();
  await expect(widthInput(page, "medium")).toBeChecked();
  await expect(layoutInput(page, "uniform")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-ratio");
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-width");
  await expect(page.locator("html")).not.toHaveAttribute("data-gallery-layout");

  const trigger = page.getByRole("button", { name: "Display settings", exact: true });
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  await trigger.click();
  await ratioInput(page, "portrait").click();
  await widthInput(page, "large").click();
  await layoutInput(page, "spotlight").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "portrait");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-width", "large");
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", "spotlight");
  await expect(page).toHaveTitle(/#e2e-fixture/);

  for (const value of LAYOUTS) {
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    await layoutInput(page, value).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await expect(layoutInput(page, value)).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", value);
    expect(new URL((await softClick(page, "/tags")).finalUrl).pathname).toBe("/tags");
    await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", value);
    expect(new URL((await softClick(page, FIXTURE_PATH)).finalUrl).pathname).toBe(FIXTURE_PATH);
    await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", value);
    await expect(layoutInput(page, value)).toBeChecked();
  }
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PREFERENCES_KEY))
    .toMatchObject({ version: 2, thumbRatio: "portrait", thumbWidth: "large", galleryLayout: "masonry" });
  await trigger.click();
  await assertSettingsAvailability(page, "masonry");
  await expect(widthInput(page, "large")).toBeChecked();
  await layoutInput(page, "uniform").click();
  await expect(ratioInput(page, "portrait")).toBeChecked();
  await expect(widthInput(page, "large")).toBeChecked();
  await layoutInput(page, "masonry").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await page.evaluate((key) => localStorage.removeItem(key), PREFERENCES_KEY);
  await page.reload();
  await expect(ratioInput(page, "square")).toBeChecked();
  await expect(widthInput(page, "medium")).toBeChecked();
  await expect(layoutInput(page, "uniform")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-ratio");
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-width");
  await expect(page.locator("html")).not.toHaveAttribute("data-gallery-layout");

  await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
    version: 1, thumbRatio: "portrait", thumbWidth: "large",
  })), PREFERENCES_KEY);
  await page.reload();
  await expect(ratioInput(page, "portrait")).toBeChecked();
  await expect(widthInput(page, "large")).toBeChecked();
  await expect(layoutInput(page, "uniform")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", "uniform");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PREFERENCES_KEY))
    .toEqual({ version: 2, thumbRatio: "portrait", thumbWidth: "large", galleryLayout: "uniform" });

  const secondTab = await context.newPage();
  await stubImageRequests(secondTab);
  await secondTab.goto(FIXTURE_PATH);
  await expect(ratioInput(secondTab, "portrait")).toBeChecked();
  await expect(widthInput(secondTab, "large")).toBeChecked();
  await expect(layoutInput(secondTab, "uniform")).toBeChecked();

  await trigger.click();
  await ratioInput(page, "landscape").click();
  await widthInput(page, "small").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(ratioInput(secondTab, "landscape")).toBeChecked();
  await expect(widthInput(secondTab, "small")).toBeChecked();

  for (const value of LAYOUTS) {
    await trigger.click();
    await layoutInput(page, value).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(layoutInput(secondTab, value)).toBeChecked();
    await expect(secondTab.locator("html")).toHaveAttribute("data-gallery-layout", value);
    await openSettings(secondTab);
    await assertSettingsAvailability(secondTab, value);
    await secondTab.getByRole("button", { name: "Close", exact: true }).click();
  }

  await openSettings(secondTab);
  await layoutInput(secondTab, "uniform").click();
  await expect(ratioInput(secondTab, "landscape")).toBeChecked();
  await expect(widthInput(secondTab, "small")).toBeChecked();
  await layoutInput(secondTab, "masonry").click();
  await secondTab.getByRole("button", { name: "Close", exact: true }).click();

  const soft = await softClick(page, "/tags");
  expect(new URL(soft.finalUrl).pathname).toBe("/tags");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "landscape");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-width", "small");
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", "masonry");
  await secondTab.close();
});

test("keeps every mode in bounds at 375, 800, and 1200px with accessible controls @smoke", async ({ page }) => {
  await page.addInitScript(() => Reflect.deleteProperty(window, "IntersectionObserver"));
  await page.goto(FIXTURE_PATH);
  const trigger = page.getByRole("button", { name: "Display settings", exact: true });
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');

  for (const width of [375, 800, 1_200]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of LAYOUTS) {
      await openSettings(page);
      await layoutInput(page, mode).click();
      await expect.poll(() => page.locator("html").evaluate(
        (root) => root.getAttribute("data-gallery-layout") ?? "uniform",
      )).toBe(mode);
      await assertSettingsAvailability(page, mode);
      const targets = await dialog.locator("label, button").evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }));
      expect(targets.every((target) => target.width >= 44 && target.height >= 44)).toBe(true);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();

      const geometry = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[data-gallery-grid="true"]');
        const cards = [...(list?.querySelectorAll<HTMLElement>(":scope > li[data-photo-id]") ?? [])];
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          listTag: list?.tagName,
          directOnly: cards.length === list?.children.length && cards.every((card) => card.tagName === "LI"),
          unique: new Set(cards.map((card) => card.dataset.photoId)).size === cards.length,
          positiveTabindex: list?.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length ?? -1,
          cards: cards.map((card) => {
            const media = card.querySelector<HTMLElement>("[data-photo-card-media]");
            const action = card.querySelector<HTMLElement>(".favorite-action");
            return {
              rect: card.getBoundingClientRect().toJSON(),
              media: media?.getBoundingClientRect().toJSON() ?? null,
              action: action?.getBoundingClientRect().toJSON() ?? null,
            };
          }),
        };
      });
      expect(geometry.viewportWidth).toBe(width);
      expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
      expect(geometry).toMatchObject({ listTag: "UL", directOnly: true, unique: true, positiveTabindex: 0 });
      for (const card of geometry.cards) {
        expect(card.rect.width).toBeGreaterThan(0);
        expect(card.rect.height).toBeGreaterThan(0);
        expect(card.rect.left).toBeGreaterThanOrEqual(-1);
        expect(card.rect.right).toBeLessThanOrEqual(width + 1);
        expect(card.media?.width ?? 0).toBeGreaterThan(0);
        expect(card.media?.height ?? 0).toBeGreaterThan(0);
        expect(card.action?.width ?? 0).toBeGreaterThanOrEqual(44);
        expect(card.action?.height ?? 0).toBeGreaterThanOrEqual(44);
        expect(card.action?.left ?? -2).toBeGreaterThanOrEqual(card.media?.left ?? -1);
        expect(card.action?.right ?? width + 2).toBeLessThanOrEqual(card.media?.right ?? width + 1);
      }
    }
  }
});

test("keeps the settings dialog internally scrollable and Close reachable in a short dynamic viewport @smoke", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 420 });
  await page.goto(FIXTURE_PATH);
  await openSettings(page);
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  const scrollArea = dialog.locator("form > div").first();
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const before = await page.evaluate(() => window.scrollY);
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scroller = element.querySelector<HTMLElement>("form > div");
    const closeButton = element.querySelector<HTMLElement>('button[value="close"]');
    return {
      viewportHeight: window.innerHeight,
      dialog: rect.toJSON(),
      scrollerClientHeight: scroller?.clientHeight ?? 0,
      scrollerScrollHeight: scroller?.scrollHeight ?? 0,
      close: closeButton?.getBoundingClientRect().toJSON() ?? null,
    };
  });
  expect(geometry.dialog.top).toBeGreaterThanOrEqual(0);
  expect(geometry.dialog.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollerScrollHeight).toBeGreaterThan(geometry.scrollerClientHeight);
  expect(geometry.close?.top ?? -1).toBeGreaterThanOrEqual(geometry.dialog.top);
  expect(geometry.close?.bottom ?? geometry.viewportHeight + 1).toBeLessThanOrEqual(geometry.dialog.bottom);
  expect(geometry.close?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(geometry.close?.height ?? 0).toBeGreaterThanOrEqual(44);
  await scrollArea.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(close).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});
