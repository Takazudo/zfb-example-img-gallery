import { expect, test, type Page } from "@playwright/test";
import { installIntersectionObserverStub, stubImageRequests, uploadPng } from "./fixtures";
import { ensureAccountMenuOpen, softClick, softSubmit } from "./navigation";

test.describe.configure({ mode: "serial" });

const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

type Credentials = { username: string; email: string; password: string };

function credentials(label: string, journeyId = runId): Credentials {
  return {
    username: `${label}${journeyId}`,
    email: `${label}-${journeyId}@example.test`,
    password: `Pw-${journeyId}-aA1!`,
  };
}

function photoCard(page: Page, path: string) {
  const id = path.split("/").at(-1);
  if (!id || !/^\d+$/.test(id)) throw new Error(`Expected a numeric photo path, got ${path}`);
  return page.locator(`li[data-photo-id="${id}"]`);
}

function mutationPosts(page: Page, pathname: string) {
  let count = 0;
  const listener = (request: import("@playwright/test").Request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === pathname) count += 1;
  };
  page.on("request", listener);
  return {
    get count() { return count; },
    dispose() { page.off("request", listener); },
  };
}

async function waitForRuntime(page: Page): Promise<void> {
  // The layout islands hydrate after the document load event. Waiting for the
  // hydrated theme control keeps the delegated gallery/favorite/delete
  // controllers from racing the first interaction on a fresh navigation.
  await expect(page.getByRole("button", { name: /Switch to (dark|light) mode/ })).toBeVisible();
}

async function resetSwapProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as typeof window & { __e2eMutationSwapCount?: number }).__e2eMutationSwapCount = 0;
  });
}

async function swapCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    (window as typeof window & { __e2eMutationSwapCount?: number }).__e2eMutationSwapCount ?? 0
  ));
}

async function register(page: Page, user: Credentials): Promise<void> {
  await page.goto("/register");
  await page.fill('input[name="username"]', user.username);
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  const result = await softSubmit(page, "/register", "Create account");
  expect(new URL(result.finalUrl).pathname).toBe("/");
}

async function signIn(page: Page, user: Credentials, expectedPath = "/"): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  const result = await softSubmit(page, "/login", "Sign in");
  expect(new URL(result.finalUrl).pathname).toBe(expectedPath);
}

async function signOut(page: Page): Promise<void> {
  await ensureAccountMenuOpen(page);
  const result = await softSubmit(page, "/logout", "Sign out");
  expect(new URL(result.finalUrl).pathname).toBe("/");
}

async function upload(page: Page, title: string): Promise<string> {
  await page.goto("/upload");
  await page.setInputFiles('input[name="photo"]', {
    name: `${title}.png`,
    mimeType: "image/png",
    buffer: uploadPng(),
  });
  await page.fill('input[name="title"]', title);
  await page.fill('textarea[name="description"]', `Deterministic photo ${title}.`);
  const result = await softSubmit(page, "/upload", "Upload photo");
  const path = new URL(result.finalUrl).pathname;
  expect(path).toMatch(/^\/photos\/\d+$/);
  return path;
}

function translationY(transform: string, translate: string): number {
  if (translate !== "none") {
    const parts = translate.trim().split(/\s+/);
    // The one-value form of the individual `translate` property is X-only;
    // Y defaults to zero. Tailwind emits two values while Y is nonzero.
    const rawY = parts.length > 1 ? parts[1] : "0";
    const value = Number.parseFloat(rawY ?? "");
    if (Number.isFinite(value)) return value;
  }
  if (transform === "none") return 0;
  const matrix = transform.match(/^matrix\(([^)]+)\)$/);
  if (matrix) return Number(matrix[1]!.split(",")[5]);
  const matrix3d = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (matrix3d) return Number(matrix3d[1]!.split(",")[13]);
  return Number.NaN;
}

function durationMilliseconds(value: string): number {
  return value.split(",").reduce((longest, item) => {
    const trimmed = item.trim();
    const amount = Number.parseFloat(trimmed);
    if (!Number.isFinite(amount)) return longest;
    return Math.max(longest, trimmed.endsWith("ms") ? amount : amount * 1_000);
  }, 0);
}

async function assertResponsiveCardSurface(page: Page): Promise<void> {
  for (const width of [375, 800, 1_200]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('li[data-photo-id]')].slice(0, 3);
      const toolbar = document.querySelector<HTMLElement>("[data-photo-selection-toolbar]");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        toolbar: toolbar ? {
          rect: toolbar.getBoundingClientRect().toJSON(),
          buttons: [...toolbar.querySelectorAll<HTMLButtonElement>("button")].map((button) => ({
            rect: button.getBoundingClientRect().toJSON(),
            minHeight: getComputedStyle(button).minHeight,
          })),
        } : null,
        cards: cards.map((card) => {
          const wrapper = card.querySelector<HTMLElement>("[data-photo-card-media-wrapper]");
          const title = card.querySelector<HTMLElement>(".photo-card-title");
          const targets = [...card.querySelectorAll<HTMLElement>(
            ".favorite-action, .photo-delete-action, .photo-select-action",
          )];
          return {
            wrapper: wrapper?.getBoundingClientRect().toJSON(),
            wrapperOverflow: wrapper ? getComputedStyle(wrapper).overflow : null,
            title: title?.getBoundingClientRect().toJSON(),
            targets: targets.map((target) => ({
              rect: target.getBoundingClientRect().toJSON(),
              width: getComputedStyle(target).width,
              height: getComputedStyle(target).height,
              minWidth: getComputedStyle(target).minWidth,
              minHeight: getComputedStyle(target).minHeight,
            })),
          };
        }),
      };
    });

    expect(metrics.viewportWidth).toBe(width);
    expect(metrics.documentWidth).toBeLessThanOrEqual(width + 1);
    expect(metrics.toolbar).not.toBeNull();
    for (const button of metrics.toolbar?.buttons ?? []) {
      expect(Number.parseFloat(button.minHeight)).toBeGreaterThanOrEqual(44);
      expect(button.rect.left).toBeGreaterThanOrEqual(-1);
      expect(button.rect.right).toBeLessThanOrEqual(width + 1);
    }
    for (const card of metrics.cards) {
      expect(card.wrapper).toBeDefined();
      expect(card.wrapperOverflow).toBe("visible");
      expect(card.title?.right ?? 0).toBeLessThanOrEqual(width + 1);
      for (const target of card.targets) {
        expect(target.rect.width).toBeGreaterThanOrEqual(44);
        expect(target.rect.height).toBeGreaterThanOrEqual(44);
        expect(target.rect.left).toBeGreaterThanOrEqual((card.wrapper?.left ?? 0) - 1);
        expect(target.rect.right).toBeLessThanOrEqual((card.wrapper?.right ?? width) + 1);
        expect(target.rect.top).toBeGreaterThanOrEqual((card.wrapper?.top ?? 0) - 1);
        expect(target.rect.bottom).toBeLessThanOrEqual((card.wrapper?.bottom ?? 900) + 1);
      }
    }
  }
}

async function assertLayoutCardOverlays(
  page: Page,
  layout: "spotlight" | "editorial",
  cardIndex: number,
): Promise<void> {
  for (const width of [375, 1_200]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(({ cardIndex, layout }) => {
      document.documentElement.setAttribute("data-gallery-layout", layout);
      const card = document.querySelectorAll<HTMLElement>('[data-gallery-grid="true"] > li[data-photo-id]')[cardIndex];
      const wrapper = card?.querySelector<HTMLElement>("[data-photo-card-media-wrapper]");
      const targets = card ? [...card.querySelectorAll<HTMLElement>(
        ".favorite-action, .photo-delete-action, .photo-select-action",
      )] : [];
      return {
        cardClass: card?.className ?? "",
        cardStyle: card ? {
          columnEnd: getComputedStyle(card).gridColumnEnd,
          rowEnd: getComputedStyle(card).gridRowEnd,
        } : null,
        wrapper: wrapper?.getBoundingClientRect().toJSON() ?? null,
        targets: targets.map((target) => ({
          rect: target.getBoundingClientRect().toJSON(),
          visibility: getComputedStyle(target).visibility,
        })),
      };
    }, { cardIndex, layout });
    expect(metrics.cardClass).toMatch(
      layout === "spotlight" ? /\bgf0\b/ : /\bgs4\b/,
    );
    expect(metrics.cardStyle?.rowEnd).toBe(width === 375 ? "span 1" : "span 2");
    expect(metrics.cardStyle?.columnEnd).toBe(
      width === 375 ? "span 1" : layout === "spotlight" ? "span 2" : "span 1",
    );
    expect(metrics.targets).toHaveLength(3);
    for (const target of metrics.targets) {
      expect(target.visibility).toBe("visible");
      expect(target.rect.width).toBeGreaterThanOrEqual(44);
      expect(target.rect.height).toBeGreaterThanOrEqual(44);
      expect(target.rect.left).toBeGreaterThanOrEqual(metrics.wrapper?.left ?? -1);
      expect(target.rect.right).toBeLessThanOrEqual(metrics.wrapper?.right ?? width + 1);
      expect(target.rect.top).toBeGreaterThanOrEqual(metrics.wrapper?.top ?? -1);
      expect(target.rect.bottom).toBeLessThanOrEqual(metrics.wrapper?.bottom ?? 901);
    }
    for (let left = 0; left < metrics.targets.length; left += 1) {
      for (let right = left + 1; right < metrics.targets.length; right += 1) {
        const a = metrics.targets[left]!.rect;
        const b = metrics.targets[right]!.rect;
        const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        expect(overlaps).toBe(false);
      }
    }
  }
}

async function assertResponsiveDetailActions(page: Page): Promise<void> {
  for (const width of [375, 800, 1_200]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const actions = document.querySelector<HTMLElement>("[data-photo-detail-actions]");
      const targets = [...document.querySelectorAll<HTMLElement>(
        "[data-photo-detail-actions] .favorite-action, [data-photo-detail-actions] .photo-detail-delete-action",
      )];
      const dialog = document.querySelector<HTMLDialogElement>("[data-photo-delete-dialog]");
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        actions: actions?.getBoundingClientRect().toJSON(),
        targets: targets.map((target) => ({
          rect: target.getBoundingClientRect().toJSON(),
          width: getComputedStyle(target).width,
          height: getComputedStyle(target).height,
        })),
        dialog: dialog ? {
          width: getComputedStyle(dialog).width,
          maxWidth: getComputedStyle(dialog).maxWidth,
        } : null,
      };
    });

    expect(metrics.viewportWidth).toBe(width);
    expect(metrics.documentWidth).toBeLessThanOrEqual(width + 1);
    expect(metrics.actions).toBeDefined();
    expect(metrics.actions?.right ?? 0).toBeLessThanOrEqual(width + 1);
    for (const target of metrics.targets) {
      expect(target.rect.width).toBeGreaterThanOrEqual(44);
      expect(target.rect.height).toBeGreaterThanOrEqual(44);
      expect(target.rect.left).toBeGreaterThanOrEqual(-1);
      expect(target.rect.right).toBeLessThanOrEqual(width + 1);
    }
    expect(metrics.dialog).not.toBeNull();
  }
}

test.beforeEach(async ({ page }) => {
  await stubImageRequests(page);
  await installIntersectionObserverStub(page);
  await page.addInitScript(() => {
    const win = window as typeof window & { __e2eMutationSwapCount?: number };
    win.__e2eMutationSwapCount = 0;
    document.addEventListener("zfb:after-swap", () => {
      win.__e2eMutationSwapCount = (win.__e2eMutationSwapCount ?? 0) + 1;
    });
  });
});

test("confirms two-user favorites, progressive cards, accessible deletion, and responsive motion @smoke", async ({ page, browser }, testInfo) => {
  const journeyId = `${runId}r${testInfo.retry}`;
  const owner = credentials("owner", journeyId);
  const viewer = credentials("viewer", journeyId);
  const titles = [1, 2, 3, 4, 5].map((number) => `Photo management ${journeyId} ${number}`);

  await register(page, owner);
  const photoPaths = [
    await upload(page, titles[0]!),
    await upload(page, titles[1]!),
    await upload(page, titles[2]!),
    await upload(page, titles[3]!),
    await upload(page, titles[4]!),
  ];

  // A protected child route carries a safe requested destination through the
  // login form and lands there after the single router swap.
  await signOut(page);
  await page.goto("/favorites/page/2");
  await expect(page).toHaveURL(/\/login\?next=%2Ffavorites%2Fpage%2F2$/);
  await expect(page.locator('input[name="next"]')).toHaveValue("/favorites/page/2");
  await page.fill('input[name="email"]', owner.email);
  await page.fill('input[name="password"]', owner.password);
  const safeLogin = await softSubmit(page, "/login", "Sign in");
  expect(new URL(safeLogin.finalUrl).pathname).toBe("/favorites/page/2");

  await signOut(page);
  await register(page, viewer);
  await page.goto("/");
  await waitForRuntime(page);

  const firstCard = photoCard(page, photoPaths[0]!);
  const firstFavorite = firstCard.locator('[data-favorite-form] button[type="submit"]');
  await expect(firstFavorite).toHaveAttribute("aria-pressed", "false");
  const outlineGeometry = await firstFavorite.locator("path").evaluate((path) => ({
    d: path.getAttribute("d"),
    viewBox: path.parentElement?.getAttribute("viewBox"),
    stroke: path.getAttribute("stroke"),
    strokeWidth: path.getAttribute("stroke-width"),
  }));
  const viewerFavoritePosts = mutationPosts(page, "/favorites");
  await resetSwapProbe(page);
  await firstFavorite.click();
  await expect(firstFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-favorite-toast="true"]')).toHaveText("You made this a favorite!");
  await expect(page.locator('[data-favorite-toast="true"]')).toHaveAttribute("role", "status");
  await expect(page.locator('[data-favorite-toast="true"]')).toHaveAttribute("aria-live", "polite");
  await expect.poll(() => viewerFavoritePosts.count).toBe(1);
  expect(await swapCount(page)).toBe(0);
  viewerFavoritePosts.dispose();

  await softClick(page, photoPaths[0]!);
  await waitForRuntime(page);
  const viewerDetailFavorite = page.locator('[data-testid="photo-detail"] [data-favorite-control] button');
  await expect(viewerDetailFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("1 favorite");
  const filledGeometry = await viewerDetailFavorite.locator("path").evaluate((path) => ({
    d: path.getAttribute("d"),
    viewBox: path.parentElement?.getAttribute("viewBox"),
    stroke: path.getAttribute("stroke"),
    strokeWidth: path.getAttribute("stroke-width"),
    fill: path.getAttribute("fill"),
  }));
  expect(filledGeometry).toMatchObject({ ...outlineGeometry, fill: "currentColor" });

  await signOut(page);
  await signIn(page, owner);
  await page.goto("/");
  await waitForRuntime(page);

  // Normal motion is checked from the actual computed translation and
  // transition events. The toast starts above its final top-center position
  // and fades in.
  const toast = page.locator('[data-favorite-toast="true"]');
  const normalBefore = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      position: style.position,
      top: style.top,
      zIndex: style.zIndex,
      opacity: style.opacity,
      transform: style.transform,
      translate: style.translate,
      transitionProperty: style.transitionProperty,
      transitionDuration: style.transitionDuration,
      rect: element.getBoundingClientRect().toJSON(),
      viewportWidth: window.innerWidth,
    };
  });
  expect(normalBefore.position).toBe("fixed");
  expect(Math.abs(normalBefore.rect.left + normalBefore.rect.width / 2 - normalBefore.viewportWidth / 2)).toBeLessThanOrEqual(1);
  expect(Number.parseFloat(normalBefore.top)).toBeGreaterThan(0);
  expect(normalBefore.zIndex).toBe("20");
  expect(normalBefore.opacity).toBe("0");
  expect(translationY(normalBefore.transform, normalBefore.translate)).toBeLessThan(0);
  expect(normalBefore.transitionProperty).toContain("opacity");
  expect(normalBefore.transitionProperty).toContain("translate");
  expect(durationMilliseconds(normalBefore.transitionDuration)).toBeGreaterThanOrEqual(150);
  await page.evaluate(() => {
    const win = window as typeof window & {
      __e2eToastEvents?: Array<{ type: string; propertyName: string; elapsed: number }>;
      __e2eToastStarted?: number;
    };
    const element = document.querySelector<HTMLElement>('[data-favorite-toast="true"]');
    if (!element) throw new Error("favorite toast is missing");
    win.__e2eToastEvents = [];
    win.__e2eToastStarted = performance.now();
    for (const type of ["transitionrun", "transitionend"]) {
      element.addEventListener(type, (event) => {
        const transition = event as TransitionEvent;
        win.__e2eToastEvents?.push({
          type,
          propertyName: transition.propertyName,
          elapsed: performance.now() - (win.__e2eToastStarted ?? performance.now()),
        });
      });
    }
  });
  const ownerCard = photoCard(page, photoPaths[0]!);
  const ownerFavorite = ownerCard.locator('[data-favorite-form] button[type="submit"]');
  await expect(ownerFavorite).toHaveAttribute("aria-pressed", "false");
  const ownerFavoritePosts = mutationPosts(page, "/favorites");
  await resetSwapProbe(page);
  await ownerFavorite.click();
  await expect(ownerFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(toast).toHaveText("You made this a favorite!");
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __e2eToastEvents?: Array<{ type: string; propertyName: string; elapsed: number }> }).__e2eToastEvents
      ?.filter((event) => event.type === "transitionend").length ?? 0
  ))).toBeGreaterThanOrEqual(2);
  const normalAfter = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, transform: style.transform, translate: style.translate };
  });
  expect(normalAfter.opacity).toBe("1");
  expect(translationY(normalAfter.transform, normalAfter.translate)).toBe(0);
  const normalEvents = await page.evaluate(() => (
    (window as typeof window & { __e2eToastEvents?: Array<{ type: string; propertyName: string; elapsed: number }> }).__e2eToastEvents ?? []
  ));
  expect(normalEvents.some((event) => event.type === "transitionrun" && event.propertyName === "translate")).toBe(true);
  expect(normalEvents.some((event) => event.type === "transitionend" && event.propertyName === "opacity" && event.elapsed > 50)).toBe(true);
  await expect.poll(() => ownerFavoritePosts.count).toBe(1);
  expect(await swapCount(page)).toBe(0);
  ownerFavoritePosts.dispose();

  await softClick(page, photoPaths[0]!);
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("2 favorites");
  const ownerDetailFavorite = page.locator('[data-testid="photo-detail"] [data-favorite-control] button');
  await expect(ownerDetailFavorite).toHaveAttribute("aria-pressed", "true");

  // The authenticated Favorites collection is a real read of the current
  // membership, not just a local card-state update.
  await page.goto("/favorites");
  await waitForRuntime(page);
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(1);
  const favoritesListButton = photoCard(page, photoPaths[0]!).locator('[data-favorite-form] button');
  await expect(favoritesListButton).toHaveAttribute("aria-pressed", "true");
  const favoritesListPosts = mutationPosts(page, "/favorites");
  await resetSwapProbe(page);
  await favoritesListButton.click();
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(0);
  await expect(page.locator('[data-favorites-collection-heading="true"]')).toContainText("0 favorites");
  await expect.poll(() => favoritesListPosts.count).toBe(1);
  expect(await swapCount(page)).toBe(0);
  favoritesListPosts.dispose();

  await page.goto(photoPaths[0]!);
  await waitForRuntime(page);
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("1 favorite");
  const restoredOwnerFavorite = page.locator('[data-testid="photo-detail"] [data-favorite-control] button');
  await expect(restoredOwnerFavorite).toHaveAttribute("aria-pressed", "false");
  await restoredOwnerFavorite.click();
  await expect(restoredOwnerFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("2 favorites");

  // A traversal after the second user changes the count must still show the
  // authoritative filled state, not an old gallery snapshot.
  await softClick(page, "/");
  await page.goBack();
  await waitForRuntime(page);
  await expect(page).toHaveURL(new RegExp(`${photoPaths[0]!.replaceAll("/", "\\/")}$`));
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("2 favorites");
  await expect(page.locator('[data-testid="photo-detail"] [data-favorite-control] button')).toHaveAttribute("aria-pressed", "true");

  // Reduced motion removes the spatial translation and makes the transition
  // effectively instant while retaining the live status announcement.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedBefore = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate, transitionDuration: style.transitionDuration };
  });
  expect(translationY(reducedBefore.transform, reducedBefore.translate)).toBe(0);
  expect(durationMilliseconds(reducedBefore.transitionDuration)).toBeLessThanOrEqual(0.01);
  const removePosts = mutationPosts(page, "/favorites");
  await resetSwapProbe(page);
  await ownerDetailFavorite.click();
  await expect(ownerDetailFavorite).toHaveAttribute("aria-pressed", "false");
  await expect(toast).toHaveText("Removed from favorites.");
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("1 favorite");
  const reducedAfter = await toast.evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, translate: style.translate, transitionDuration: style.transitionDuration };
  });
  expect(translationY(reducedAfter.transform, reducedAfter.translate)).toBe(0);
  expect(durationMilliseconds(reducedAfter.transitionDuration)).toBeLessThanOrEqual(0.01);
  await expect.poll(() => removePosts.count).toBe(1);
  expect(await swapCount(page)).toBe(0);
  removePosts.dispose();

  await softClick(page, "/");
  await page.goBack();
  await expect(page.locator('[data-favorite-count="true"]')).toHaveText("1 favorite");
  await expect(page.locator('[data-testid="photo-detail"] [data-favorite-control] button')).toHaveAttribute("aria-pressed", "false");
  await page.goto("/favorites");
  await waitForRuntime(page);
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: null });
  await page.goto("/tags/e2e-fixture");
  await waitForRuntime(page);
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
  await page.locator('[data-gallery-next-link="true"]').click();
  await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(48);
  const appendedFavorite = page
    .locator('[data-gallery-grid="true"] > li[data-photo-id]')
    .nth(24)
    .locator('[data-favorite-form] button');
  await expect(appendedFavorite).toBeVisible();
  await expect(appendedFavorite).toHaveAttribute("aria-pressed", "false");
  const appendedFavoritePosts = mutationPosts(page, "/favorites");
  await resetSwapProbe(page);
  await appendedFavorite.click();
  await expect(appendedFavorite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-favorite-toast="true"]')).toHaveText("You made this a favorite!");
  await expect.poll(() => appendedFavoritePosts.count).toBe(1);
  expect(await swapCount(page)).toBe(0);
  await resetSwapProbe(page);
  await appendedFavorite.click();
  await expect(appendedFavorite).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator('[data-favorite-toast="true"]')).toHaveText("Removed from favorites.");
  await expect.poll(() => appendedFavoritePosts.count).toBe(2);
  expect(await swapCount(page)).toBe(0);
  appendedFavoritePosts.dispose();

  await page.goto("/my-photos");
  await waitForRuntime(page);
  await expect(page.locator('[data-photo-delete-form="true"]')).toHaveCount(5);
  await expect(page.locator('[data-photo-select="true"]')).toHaveCount(5);
  await assertLayoutCardOverlays(page, "spotlight", 0);
  await assertLayoutCardOverlays(page, "editorial", 4);
  await assertResponsiveCardSurface(page);
  await page.goto(photoPaths[1]!);
  await waitForRuntime(page);
  await expect(page.locator('[data-photo-detail-actions] .photo-detail-delete-action')).toHaveCount(1);
  await assertResponsiveDetailActions(page);
  await page.goto("/my-photos");
  await waitForRuntime(page);

  // Single deletion: keyboard activation, Escape cancellation, focus return,
  // then one confirmed JSON mutation with no competing router swap.
  const firstDelete = photoCard(page, photoPaths[0]!).locator(".photo-delete-action");
  const dialog = page.locator('[data-photo-delete-dialog="true"]');
  const singleDeletePosts = mutationPosts(page, "/my-photos");
  await resetSwapProbe(page);
  await firstDelete.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(firstDelete).toBeFocused();
  expect(singleDeletePosts.count).toBe(0);

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(firstDelete).toBeFocused();
  expect(singleDeletePosts.count).toBe(0);

  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => singleDeletePosts.count).toBe(1);
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(0);
  expect(await swapCount(page)).toBe(0);
  singleDeletePosts.dispose();

  // Traversing away and back cannot resurrect the deleted card.
  await softClick(page, photoPaths[1]!);
  await page.goBack();
  await expect(page).toHaveURL(/\/my-photos$/);
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`${photoPaths[1]!.replaceAll("/", "\\/")}$`));
  await page.goBack();
  await expect(photoCard(page, photoPaths[0]!)).toHaveCount(0);

  // A non-owner sees the public card/detail but none of the owner delete UI.
  // Start the identity switch from a settled direct navigation: the stale-card
  // assertion above can complete while zfb is still finishing its traversal
  // refetch, which would otherwise detach the header during the logout click.
  await page.goto("/my-photos");
  await waitForRuntime(page);
  await signOut(page);
  await signIn(page, viewer);
  await page.goto(photoPaths[1]!);
  await expect(page.locator('[data-photo-delete-form="true"]')).toHaveCount(0);
  await page.goto("/");
  await expect(photoCard(page, photoPaths[1]!).locator('[data-photo-delete-form="true"]')).toHaveCount(0);
  await expect(page.locator("[data-photo-selection-toolbar]")).toHaveCount(0);

  await signOut(page);
  await signIn(page, owner);
  await page.goto("/my-photos");
  await waitForRuntime(page);
  await expect(page.locator('[data-photo-delete-form="true"]')).toHaveCount(4);

  // The same owner action remains usable without JavaScript: the first POST
  // returns a confirmation document, and only the explicit second POST
  // deletes the selected photo. This uses the same browser/server lifecycle.
  const noJsOwner = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    javaScriptEnabled: false,
  });
  try {
    await noJsOwner.addCookies(await page.context().cookies());
    const noJsOwnerPage = await noJsOwner.newPage();
    await noJsOwnerPage.goto("/my-photos");
    const noJsSecondCard = photoCard(noJsOwnerPage, photoPaths[1]!);
    await noJsSecondCard.locator(".photo-delete-action").click();
    await expect(noJsOwnerPage.locator("[data-delete-confirmation]")).toBeVisible();
    await noJsOwnerPage.getByRole("button", { name: "Delete permanently" }).click();
    await expect(noJsOwnerPage).toHaveURL(/\/my-photos$/);
    await expect(photoCard(noJsOwnerPage, photoPaths[1]!)).toHaveCount(0);
  } finally {
    await noJsOwner.close();
  }
  await page.goto("/my-photos");
  await waitForRuntime(page);
  await expect(page.locator('[data-photo-delete-form="true"]')).toHaveCount(3);

  // Bulk deletion: select several personal cards, cancel once with Escape,
  // then confirm exactly one bounded mutation and an empty refreshed feed.
  const remainingCards = page.locator('li[data-photo-id]');
  const remainingInputs = remainingCards.locator('[data-photo-select="true"]');
  await remainingInputs.nth(0).check();
  await remainingInputs.nth(1).check();
  await remainingInputs.nth(2).check();
  const selectedCount = page.locator('[data-photo-selected-count="true"]');
  await expect(selectedCount).toHaveAttribute("aria-live", "polite");
  await expect(selectedCount).toHaveAttribute("aria-atomic", "true");
  await expect(selectedCount).toHaveText("3 photos selected");
  const bulkDeletePosts = mutationPosts(page, "/my-photos");
  await resetSwapProbe(page);
  const bulkDeleteButton = page.locator('[data-photo-bulk-delete="true"]');
  await bulkDeleteButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(selectedCount).toHaveText("3 photos selected");
  expect(bulkDeletePosts.count).toBe(0);

  await bulkDeleteButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(bulkDeleteButton).toBeFocused();
  await expect(selectedCount).toHaveText("3 photos selected");
  expect(bulkDeletePosts.count).toBe(0);

  await bulkDeleteButton.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => bulkDeletePosts.count).toBe(1);
  await expect(page.locator('li[data-photo-id]')).toHaveCount(0);
  await expect(page.locator("[data-delete-confirmation]")).toHaveCount(0);
  await expect(page.locator("text=No photos yet")).toBeVisible();
  await expect(selectedCount).toHaveText("0 photos selected");
  expect(await swapCount(page)).toBe(0);
  bulkDeletePosts.dispose();

  await softClick(page, "/");
  await page.goBack();
  await expect(page).toHaveURL(/\/my-photos$/);
  await expect(page.locator('li[data-photo-id]')).toHaveCount(0);
  await page.goForward();
  await page.goBack();
  await expect(page.locator('li[data-photo-id]')).toHaveCount(0);

  // Keep the browser context explicitly single-worker and prove the canonical
  // no-JS pagination fallback remains reachable without starting a second
  // server. The owner confirmation was exercised above in the same context.
  const noJs = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    javaScriptEnabled: false,
  });
  try {
    const noJsPage = await noJs.newPage();
    await noJsPage.goto("/tags/e2e-fixture");
    await expect(noJsPage.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
    await noJsPage.locator('[data-gallery-next-link="true"]').click();
    await expect(noJsPage).toHaveURL(/\/tags\/e2e-fixture\/page\/2$/);
  } finally {
    await noJs.close();
  }
});
