import { expect, test } from "@playwright/test";
import {
  pngWithDimensions,
  stubImageRequests,
} from "./fixtures";
import { softClick } from "./navigation";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PREFERENCES_KEY = "stillframe-gallery-preferences";

function ratioInput(page: import("@playwright/test").Page, value: string) {
  return page.locator(`input[name="thumbnail-ratio"][value="${value}"]`);
}

function widthInput(page: import("@playwright/test").Page, value: string) {
  return page.locator(`input[name="thumbnail-width"][value="${value}"]`);
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

test("supports pointer and keyboard dialog control, every choice, Original geometry, and appended cards @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as typeof window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
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

  // Original uses each image's intrinsic mixed ratio rather than forcing one
  // crop ratio. The fixture's first two cards intentionally differ.
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
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const next = page.locator('[data-gallery-next-link="true"]');
  await next.click();
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(48);
  const appended = page.locator('[data-gallery-grid="true"] > li[data-photo-id]').nth(47).locator("img");
  await expect(appended).toBeVisible();
  await expect.poll(() => appended.evaluate((image) => {
    const styles = getComputedStyle(image);
    return {
      objectFit: styles.objectFit,
      aspectRatio: styles.aspectRatio,
      width: getComputedStyle(document.documentElement).getPropertyValue("--gallery-thumbnail-width").trim(),
    };
  })).toEqual({ objectFit: "cover", aspectRatio: "4 / 3", width: "9rem" });
});

test("defaults invalid or deleted storage and persists through reload, tabs, and soft navigation @smoke", async ({ page, context }) => {
  await page.addInitScript((key) => {
    const onceKey = "__e2e-invalid-gallery-preferences-seeded";
    if (sessionStorage.getItem(onceKey) === "1") return;
    localStorage.setItem(key, JSON.stringify({ version: 99, thumbRatio: "portrait", thumbWidth: "large" }));
    sessionStorage.setItem(onceKey, "1");
  }, PREFERENCES_KEY);
  await page.goto(FIXTURE_PATH);
  await expect(ratioInput(page, "square")).toBeChecked();
  await expect(widthInput(page, "medium")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-ratio");
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-width");

  const trigger = page.getByRole("button", { name: "Display settings", exact: true });
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  await trigger.click();
  await ratioInput(page, "portrait").click();
  await widthInput(page, "large").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "portrait");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-width", "large");
  await expect(page).toHaveTitle(/#e2e-fixture/);

  await page.reload();
  await expect(ratioInput(page, "portrait")).toBeChecked();
  await expect(widthInput(page, "large")).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "portrait");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-width", "large");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), PREFERENCES_KEY))
    .toMatchObject({ version: 1, thumbRatio: "portrait", thumbWidth: "large" });

  await page.evaluate((key) => localStorage.removeItem(key), PREFERENCES_KEY);
  await page.reload();
  await expect(ratioInput(page, "square")).toBeChecked();
  await expect(widthInput(page, "medium")).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-ratio");
  await expect(page.locator("html")).not.toHaveAttribute("data-thumb-width");

  const secondTab = await context.newPage();
  await stubImageRequests(secondTab);
  await secondTab.goto(FIXTURE_PATH);
  await expect(ratioInput(secondTab, "square")).toBeChecked();
  await trigger.click();
  await ratioInput(page, "landscape").click();
  await widthInput(page, "small").click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(ratioInput(secondTab, "landscape")).toBeChecked();
  await expect(widthInput(secondTab, "small")).toBeChecked();
  await expect(secondTab.locator("html")).toHaveAttribute("data-thumb-ratio", "landscape");
  await expect(secondTab.locator("html")).toHaveAttribute("data-thumb-width", "small");

  const soft = await softClick(page, "/tags");
  expect(new URL(soft.finalUrl).pathname).toBe("/tags");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-ratio", "landscape");
  await expect(page.locator("html")).toHaveAttribute("data-thumb-width", "small");
  await secondTab.close();
});
