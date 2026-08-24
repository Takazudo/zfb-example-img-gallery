import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { softClick } from "./navigation";

const THEME_STORAGE_KEY = "stillframe-theme";
const NO_RELOAD_SENTINEL = "__themeNavigationNoReload";

type ThemeMode = "light" | "dark";

type BrowserErrorCapture = {
  messages: string[];
  onPage: (page: Page) => void;
};

const browserErrorCaptures = new WeakMap<BrowserContext, BrowserErrorCapture>();

function attachBrowserErrorCapture(page: Page, messages: string[]): void {
  page.on("console", (message) => {
    if (message.type() === "error") messages.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => messages.push(`page: ${error.message}`));
}

test.beforeEach(async ({ context }) => {
  const messages: string[] = [];
  const onPage = (page: Page) => attachBrowserErrorCapture(page, messages);
  for (const page of context.pages()) attachBrowserErrorCapture(page, messages);
  context.on("page", onPage);
  browserErrorCaptures.set(context, { messages, onPage });
});

test.afterEach(async ({ context }) => {
  const capture = browserErrorCaptures.get(context);
  if (!capture) return;
  context.off("page", capture.onPage);
  browserErrorCaptures.delete(context);
  expect(capture.messages).toEqual([]);
});

function themeButton(page: Page, mode: ThemeMode) {
  return page.getByRole("button", {
    name: mode === "light" ? "Switch to dark mode" : "Switch to light mode",
    exact: true,
  });
}

async function readThemeState(page: Page) {
  return page.evaluate((storageKey) => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const bodyStyles = getComputedStyle(document.body);
    return {
      rootTheme: root.getAttribute("data-theme"),
      colorScheme: styles.colorScheme,
      paper: bodyStyles.backgroundColor,
      ink: bodyStyles.color,
      storedTheme: localStorage.getItem(storageKey),
    };
  }, THEME_STORAGE_KEY);
}

async function expectThemeAndHeader(page: Page, mode: ThemeMode) {
  const button = themeButton(page, mode);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute(
    "aria-label",
    mode === "light" ? "Switch to dark mode" : "Switch to light mode",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Gallery", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Authors", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tags", exact: true })).toBeVisible();

  const state = await readThemeState(page);
  expect(state.colorScheme).toBe(mode);
  expect(state.paper).toBeTruthy();
  expect(state.ink).toBeTruthy();
  expect(state.paper).not.toBe(state.ink);
  expect(state.storedTheme).toBe(mode);
}

for (const mode of ["light", "dark"] as const) {
  test(`follows the OS ${mode} preference with empty storage @smoke`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto("/");

    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
    await expect(themeButton(page, mode)).toBeVisible();
    const state = await readThemeState(page);
    expect(state.rootTheme).toBeNull();
    expect(state.storedTheme).toBeNull();
    expect(state.colorScheme).toBe(mode);
    expect(state.paper).toBeTruthy();
    expect(state.ink).toBeTruthy();
    expect(state.paper).not.toBe(state.ink);
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`applies stored ${mode} mode before the first visible frame @smoke`, async ({ page }) => {
    await page.addInitScript(
      ({ storageKey, storedMode }) => {
        localStorage.setItem(storageKey, storedMode);
        const win = window as typeof window & {
          __themeFirstFrame?: { rootTheme: string | null; colorScheme: string };
        };
        const capture = () => {
          if (!document.body) {
            requestAnimationFrame(capture);
            return;
          }
          const root = document.documentElement;
          win.__themeFirstFrame = {
            rootTheme: root.getAttribute("data-theme"),
            colorScheme: getComputedStyle(root).colorScheme,
          };
        };
        requestAnimationFrame(capture);
      },
      { storageKey: THEME_STORAGE_KEY, storedMode: mode },
    );
    await page.goto("/");

    const documentSource = await page.content();
    expect(documentSource.indexOf("data-theme-bootstrap")).toBeLessThan(
      documentSource.indexOf('href="/assets/app.css"'),
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = (window as typeof window & {
            __themeFirstFrame?: { rootTheme: string | null; colorScheme: string };
          }).__themeFirstFrame;
          return state ?? null;
        }),
      )
      .toEqual({ rootTheme: mode, colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(themeButton(page, mode)).toBeVisible();
    await expect(themeButton(page, mode)).toHaveAttribute(
      "aria-label",
      mode === "light" ? "Switch to dark mode" : "Switch to light mode",
    );
  });
}

test("tracks live OS changes until an explicit toggle wins @smoke", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(themeButton(page, "light")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(themeButton(page, "dark")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");

  await themeButton(page, "dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(themeButton(page, "light")).toBeVisible();

  // Exercise two actual system changes after the explicit choice. The explicit
  // root/storage state must remain authoritative through both transitions.
  await page.emulateMedia({ colorScheme: "light" });
  await expect(themeButton(page, "light")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await readThemeState(page)).toMatchObject({
    colorScheme: "light",
    storedTheme: "light",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(themeButton(page, "light")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const explicitState = await readThemeState(page);
  expect(explicitState).toMatchObject({
    colorScheme: "light",
    storedTheme: "light",
  });
});

test("persists an explicit toggle across reload and soft GET swaps @smoke", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(themeButton(page, "light")).toBeVisible();

  await themeButton(page, "light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(themeButton(page, "dark")).toBeVisible();
  const explicitState = await readThemeState(page);
  expect(explicitState).toMatchObject({
    rootTheme: "dark",
    storedTheme: "dark",
    colorScheme: "dark",
  });

  await page.reload();
  await expectThemeAndHeader(page, "dark");

  await page.evaluate((sentinel) => {
    (window as unknown as Record<string, string>)[sentinel] = "alive";
  }, NO_RELOAD_SENTINEL);
  const authorsSwap = await softClick(page, "/authors");
  const afterAuthorsSentinel = await page.evaluate(
    (sentinel) => (window as unknown as Record<string, string>)[sentinel],
    NO_RELOAD_SENTINEL,
  );
  expect(afterAuthorsSentinel).toBe("alive");
  expect(new URL(authorsSwap.finalUrl).pathname).toBe("/authors");
  await expect(page).toHaveURL(/\/authors$/);
  await expect(page).toHaveTitle("Authors | Stillframe");
  await expect(page.locator("h1")).toHaveText("Authors");
  await expect(page.getByRole("link", { name: "Authors", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectThemeAndHeader(page, "dark");

  const tagsSwap = await softClick(page, "/tags");
  const afterTagsSentinel = await page.evaluate(
    (sentinel) => (window as unknown as Record<string, string>)[sentinel],
    NO_RELOAD_SENTINEL,
  );
  expect(afterTagsSentinel).toBe("alive");
  expect(new URL(tagsSwap.finalUrl).pathname).toBe("/tags");
  await expect(page).toHaveURL(/\/tags$/);
  await expect(page).toHaveTitle("Tags | Stillframe");
  await expect(page.locator("h1")).toHaveText("Tags");
  await expect(page.getByRole("link", { name: "Tags", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectThemeAndHeader(page, "dark");
});

test("synchronizes a theme choice to a second browser tab @smoke", async ({ context }) => {
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  await firstTab.emulateMedia({ colorScheme: "light" });
  await secondTab.emulateMedia({ colorScheme: "light" });
  await Promise.all([firstTab.goto("/"), secondTab.goto("/")]);

  await expect(themeButton(firstTab, "light")).toBeVisible();
  await expect(themeButton(secondTab, "light")).toBeVisible();
  await themeButton(firstTab, "light").click();

  await expect(themeButton(firstTab, "dark")).toBeVisible();
  await expect(secondTab.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(themeButton(secondTab, "dark")).toBeVisible();
  const syncedState = await readThemeState(secondTab);
  expect(syncedState).toMatchObject({
    rootTheme: "dark",
    storedTheme: "dark",
  });
});
