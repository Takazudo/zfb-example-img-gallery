import { expect, test } from "@playwright/test";
import { stubImageRequests } from "./fixtures";
import { softClick } from "./navigation";

test("restores a browser-created fragment entry and traverses forward without reloading @smoke", async ({ page }) => {
  await stubImageRequests(page);
  await page.goto("/tags/e2e-fixture");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
  const title = await page.title();
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__fragmentHistorySentinel = true;
    // Assigning the fragment uses the browser's History entry, not the router's.
    location.hash = "gallery-fragment";
  });
  await expect(page).toHaveURL(/\/tags\/e2e-fixture#gallery-fragment$/);
  expect(await page.evaluate(() => history.state)).toBeNull();
  await softClick(page, "/authors");
  await expect(page).toHaveURL(/\/authors$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/tags\/e2e-fixture#gallery-fragment$/);
  await expect(page).toHaveTitle(title);
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
  await page.evaluate(() => {
    document.addEventListener("zfb:before-preparation", (event) => {
      (window as unknown as Record<string, unknown>).__fragmentForwardDirection =
        (event as Event & { direction: string }).direction;
    }, { once: true });
  });
  await page.goForward();
  await expect(page).toHaveURL(/\/authors$/);
  await expect(page.getByRole("heading", { name: "Authors", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__fragmentForwardDirection)).toBe("forward");
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__fragmentHistorySentinel)).toBe(true);
});
