import { expect, test, type Locator, type Page } from "@playwright/test";
import { stubImageRequests } from "./fixtures";
import { ensureAccountMenuOpen, softClick, softSubmit } from "./navigation";

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

type Credentials = { username: string; email: string; password: string };

function credentials(label: string, username = `${label}${runId}`): Credentials {
  return {
    username,
    email: `${label}-${runId}@example.test`,
    password: `Pw-${runId}-aA1!`,
  };
}

async function register(page: Page, user: Credentials): Promise<void> {
  await page.goto("/register");
  await page.fill('input[name="username"]', user.username);
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  const result = await softSubmit(page, "/register", "Create account");
  expect(new URL(result.finalUrl).pathname).toBe("/");
}

async function assertTargetSize(target: Locator): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
}

async function assertHeaderRowHeight(page: Page): Promise<void> {
  const row = page.locator("header > div").first();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  expect(box.height).toBeLessThanOrEqual(64);
}

function primaryLinks(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Primary" });
  return {
    navigation,
    gallery: navigation.getByRole("link", { name: "Gallery", exact: true }),
    authors: navigation.getByRole("link", { name: "Authors", exact: true }),
    tags: navigation.getByRole("link", { name: "Tags", exact: true }),
  };
}

async function assertPhoneHeader(page: Page, signedIn: boolean, user?: Credentials): Promise<void> {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  const { navigation } = primaryLinks(page);
  const menu = page.locator("#primary-menu");
  const gallery = menu.getByRole("link", { name: "Gallery", exact: true });
  const authors = menu.getByRole("link", { name: "Authors", exact: true });
  const tags = menu.getByRole("link", { name: "Tags", exact: true });
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  const displaySettings = menu.getByRole("button", { name: "Display settings", exact: true });
  const theme = page.getByRole("button", { name: /Switch to (dark|light) mode/ });
  await expect(navigation).toBeVisible();
  await expect(menuButton).toBeVisible();
  await expect(theme).toBeVisible();
  await expect(menu).not.toBeVisible();
  await expect(gallery).not.toBeVisible();
  await expect(authors).not.toBeVisible();
  await expect(tags).not.toBeVisible();
  await expect(displaySettings).not.toBeVisible();
  await assertTargetSize(menuButton);
  await assertTargetSize(theme);

  if (signedIn) {
    if (!user) throw new Error("Signed-in header checks require credentials");
    const upload = page.getByRole("link", { name: "Upload", exact: true });
    const account = page.getByRole("button", { name: "Account menu", exact: true });
    await expect(upload).toBeVisible();
    await expect(account).toBeVisible();
    await assertTargetSize(upload);
    await assertTargetSize(account);
  } else {
    const signIn = page.getByRole("link", { name: "Sign in", exact: true });
    const registerLink = page.getByRole("link", { name: "Register", exact: true });
    await expect(signIn).toBeVisible();
    await expect(registerLink).toBeVisible();
    await assertTargetSize(signIn);
    await assertTargetSize(registerLink);
  }

  await assertNoHorizontalOverflow(page);
  await assertHeaderRowHeight(page);

  await menuButton.click();
  await expect(menu).toBeVisible();
  await expect(gallery).toBeVisible();
  await expect(authors).toBeVisible();
  await expect(tags).toBeVisible();
  await expect(displaySettings).toBeVisible();
  await expect(gallery).toHaveAttribute("autofocus", "");
  await assertNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(menuButton).toBeFocused();
}

async function assertDesktopHeader(page: Page, signedIn: boolean, user?: Credentials): Promise<void> {
  for (const width of [800, 1_200]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");

    const { navigation, gallery, authors, tags } = primaryLinks(page);
    const menuButton = page.getByRole("button", { name: "Menu", exact: true });
    const displaySettings = page.getByRole("button", { name: "Display settings", exact: true });
    const theme = page.getByRole("button", { name: /Switch to (dark|light) mode/ });
    await expect(navigation).toBeVisible();
    await expect(gallery).toBeVisible();
    await expect(authors).toBeVisible();
    await expect(tags).toBeVisible();
    await expect(displaySettings).toBeVisible();
    await expect(menuButton).not.toBeVisible();
    await assertTargetSize(displaySettings);
    await assertTargetSize(theme);

    if (signedIn) {
      if (!user) throw new Error("Signed-in header checks require credentials");
      const upload = page.getByRole("link", { name: "Upload", exact: true });
      const account = page.getByRole("button", { name: "Account menu", exact: true });
      await expect(upload).toBeVisible();
      await expect(account).toBeVisible();
      const accountName = account.locator("span").filter({ hasText: `@${user.username}` }).first();
      if (width < 1_024) {
        await expect(accountName).not.toBeVisible();
      } else {
        await expect(accountName).toBeVisible();
      }
    }

    await assertNoHorizontalOverflow(page);
  }
}

async function expectTooltipAtFullOpacity(control: Locator): Promise<void> {
  const tooltip = control.locator('span[aria-hidden="true"]');
  await expect(tooltip).toHaveCount(1);
  await expect.poll(() => tooltip.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
}

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
});

test("covers the signed-out and signed-in responsive header contract @smoke", async ({ page }) => {
  await assertPhoneHeader(page, false);
  await assertDesktopHeader(page, false);

  const user = credentials("header");
  await register(page, user);
  await assertPhoneHeader(page, true, user);
  await assertDesktopHeader(page, true, user);
});

test("reveals icon-only tooltips on hover, focus, and press", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");

  const theme = page.getByRole("button", { name: /Switch to (dark|light) mode/ });
  await theme.hover();
  await expectTooltipAtFullOpacity(theme);

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await theme.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(theme).toBeFocused();
  await expectTooltipAtFullOpacity(theme);

  const user = credentials("tooltip");
  await register(page, user);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const upload = page.getByRole("link", { name: "Upload", exact: true });
  const uploadBox = await upload.boundingBox();
  expect(uploadBox).not.toBeNull();
  if (!uploadBox) return;
  await page.mouse.move(uploadBox.x + uploadBox.width / 2, uploadBox.y + uploadBox.height / 2);
  await page.mouse.down();
  await expectTooltipAtFullOpacity(upload);
  await page.mouse.up();
});

test("closes the phone sheet after soft navigation and marks Authors active", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  const menu = page.locator("#primary-menu");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(menu).toBeVisible();
  const swap = await softClick(page, "/authors");
  expect(new URL(swap.finalUrl).pathname).toBe("/authors");
  await expect(menu).not.toBeVisible();

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  const authors = menu.getByRole("link", { name: "Authors", exact: true });
  await expect(authors).toBeVisible();
  await expect(authors).toHaveAttribute("aria-current", "page");
});

test("keeps the phone sheet open around the Display settings dialog", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");

  const menu = page.locator("#primary-menu");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(menu).toBeVisible();
  const displaySettings = menu.getByRole("button", { name: "Display settings", exact: true });
  await displaySettings.click();
  const dialog = page.locator('dialog[aria-labelledby="display-settings-title"]');
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(displaySettings).toBeFocused();
  await expect(menu).toBeVisible();
});

test("light-dismisses the signed-in account menu", async ({ page }) => {
  const user = credentials("dismiss");
  await register(page, user);
  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");

  await ensureAccountMenuOpen(page);
  await expect(page.locator("#account-menu")).toBeVisible();
  await page.locator("h1").click();
  await expect(page.locator("#account-menu")).not.toBeVisible();
});

test("keeps a 24-character username within the 800px header and truncates it at 1280px", async ({ page }) => {
  const username = `${"u".repeat(24 - runId.length)}${runId}`;
  const user = credentials("long", username);
  await register(page, user);

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  await assertNoHorizontalOverflow(page);
  await assertHeaderRowHeight(page);
  const accountAt800 = page.getByRole("button", { name: "Account menu", exact: true });
  await expect(accountAt800).toBeVisible();
  await expect(accountAt800.locator("span").filter({ hasText: `@${username}` }).first()).not.toBeVisible();

  await page.setViewportSize({ width: 1_280, height: 800 });
  await page.goto("/");
  const accountAt1280 = page.getByRole("button", { name: "Account menu", exact: true });
  const usernameLabel = accountAt1280.locator("span").filter({ hasText: `@${username}` }).first();
  await expect(usernameLabel).toBeVisible();
  await expect(accountAt1280).toContainText(`@${username}`);
  const truncation = await usernameLabel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      maxWidth: style.maxWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(truncation.maxWidth).toBe("160px");
  expect(truncation.overflow).toBe("hidden");
  expect(truncation.textOverflow).toBe("ellipsis");
  expect(truncation.whiteSpace).toBe("nowrap");
  expect(truncation.scrollWidth).toBeGreaterThanOrEqual(truncation.clientWidth);
});
