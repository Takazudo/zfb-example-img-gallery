import { expect, test } from "@playwright/test";
import {
  installIntersectionObserverStub,
  stubImageRequests,
  triggerIntersection,
} from "./fixtures";
import { softClick } from "./navigation";

const FIXTURE_PATH = "/tags/e2e-fixture";
const PAGE_TWO_PATH = `${FIXTURE_PATH}/page/2`;
const PAGE_THREE_PATH = `${FIXTURE_PATH}/page/3`;
const NON_UNIFORM_LAYOUTS = ["spotlight", "editorial", "justified", "masonry"] as const;

function grid(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-grid="true"] > li[data-photo-id]');
}

function nextLink(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-next-link="true"]');
}

function status(page: import("@playwright/test").Page) {
  return page.locator('[data-gallery-status="true"]');
}

async function orderedIds(page: import("@playwright/test").Page): Promise<string[]> {
  return grid(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-photo-id") ?? ""));
}

async function setRootLayout(
  page: import("@playwright/test").Page,
  layout: typeof NON_UNIFORM_LAYOUTS[number],
): Promise<void> {
  await page.evaluate((value) => document.documentElement.setAttribute("data-gallery-layout", value), layout);
  await expect(page.locator("html")).toHaveAttribute("data-gallery-layout", layout);
}

async function layoutMetadata(page: import("@playwright/test").Page, start: number, count: number) {
  return grid(page).evaluateAll((cards, range) => cards.slice(range.start, range.start + range.count).map((card) => {
    const style = getComputedStyle(card);
    return {
      id: card.getAttribute("data-photo-id"),
      role: [...card.classList].find((name) => /^g[fs][0-9a]$/.test(name)) ?? "",
      aspect: card.style.getPropertyValue("--a"),
      columnStart: style.gridColumnStart,
      columnEnd: style.gridColumnEnd,
      rowStart: style.gridRowStart,
      rowEnd: style.gridRowEnd,
    };
  }), { start, count });
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

test("loads delayed batches, disarms the observer, reaches the remainder, and retries failures @smoke", async ({ page }) => {
  const pageTwo = delayedResponse();
  const pageThree = delayedResponse();
  let pageTwoRequests = 0;
  let pageThreeRequests = 0;

  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    pageTwoRequests += 1;
    await pageTwo.released;
    await route.continue();
  });
  await page.route(`**${PAGE_THREE_PATH}`, async (route) => {
    pageThreeRequests += 1;
    await pageThree.released;
    await route.continue();
  });

  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(24);
  await expect(page.locator('[data-gallery-feed-next]')).toBeHidden();
  const initialIds = await orderedIds(page);
  await expect(nextLink(page)).toHaveText("Load next 24 photos");

  await triggerIntersection(page, true);
  await expect(status(page)).toHaveText("Loading 24 photos…");
  expect(pageTwoRequests).toBe(1);
  pageTwo.release();
  await expect(grid(page)).toHaveCount(48);
  await expect(status(page)).toHaveText("Loaded 24 photos.");
  await expect(nextLink(page)).toHaveText("Load next 2 photos");
  await expect(nextLink(page)).toHaveAttribute("href", PAGE_THREE_PATH);

  // An observer that remains intersecting must not cascade another request
  // after an automatic success. The gate requires a leave/re-enter sample.
  await triggerIntersection(page, true);
  await expect.poll(() => pageTwoRequests).toBe(1);
  await expect(status(page)).toHaveText("Loaded 24 photos.");

  // The gate requires a leave/re-enter sample before the next observer load.
  // The fallback link is intentionally hidden while automatic mode is active.
  await triggerIntersection(page, false);
  await triggerIntersection(page, true);
  await expect(status(page)).toHaveText("Loading 2 photos…");
  expect(pageThreeRequests).toBe(1);
  pageThree.release();
  await expect(grid(page)).toHaveCount(50);
  const finalIds = await orderedIds(page);
  expect(finalIds.slice(0, initialIds.length)).toEqual(initialIds);
  expect(new Set(finalIds).size).toBe(finalIds.length);
  await expect(status(page)).toHaveText("All photos loaded");
  await expect(page.locator('[data-gallery-feed-next]')).toHaveCount(0);
  await expect(nextLink(page)).toHaveCount(0);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(0);
  await expect(page.locator('[data-gallery-auto-load-sentinel="true"]')).toHaveCount(0);
});

test("keeps the existing grid and canonical retry link after one non-success response @smoke", async ({ page }) => {
  let requests = 0;
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "fixture failure",
      });
      return;
    }
    await route.continue();
  });

  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(24);
  await expect(page.locator('[data-gallery-feed-next]')).toBeHidden();
  const firstIds = await grid(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-photo-id")));
  const firstHref = await nextLink(page).getAttribute("href");

  await triggerIntersection(page, true);
  await expect(status(page)).toContainText("Could not load photos");
  expect(await grid(page).count()).toBe(24);
  expect(await grid(page).evaluateAll((cards) => cards.map((card) => card.getAttribute("data-photo-id")))).toEqual(firstIds);
  expect(await nextLink(page).getAttribute("href")).toBe(firstHref);
  await expect(nextLink(page)).toContainText("Load next 24 photos");
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(0);
  await expect(page.locator('[data-gallery-auto-load-sentinel="true"]')).toHaveCount(0);

  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);
  const retriedIds = await orderedIds(page);
  expect(retriedIds.slice(0, firstIds.length)).toEqual(firstIds);
  expect(new Set(retriedIds).size).toBe(retriedIds.length);
  expect(requests).toBe(2);
  await expect(status(page)).toHaveText("Loaded 24 photos.");
});

test("restores two loaded batches through a router photo click and Back without a reload @smoke", async ({ page }) => {
  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(24);
  await triggerIntersection(page, true);
  await expect(grid(page)).toHaveCount(48);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(2);
  const beforeIds = await orderedIds(page);
  const beforeMetadata = await layoutMetadata(page, 0, 48);

  const target = grid(page).nth(35).locator('[data-photo-card-media-wrapper] > a.photo-card-link');
  const targetHref = await target.getAttribute("href");
  const before = await page.evaluate((href) => {
    const anchor = document.querySelector(`a[href="${href}"]`);
    return {
      scrollY: window.scrollY,
      top: anchor?.getBoundingClientRect().top ?? null,
    };
  }, targetHref);
  expect(targetHref).toMatch(/^\/photos\/\d+$/);
  expect(before.top).not.toBeNull();
  await page.evaluate(() => {
    (window as typeof window & { __e2eNoReload?: string }).__e2eNoReload = "alive";
  });

  const swap = await softClick(page, targetHref!);
  expect(new URL(swap.finalUrl).pathname).toMatch(/^\/photos\/\d+$/);
  await expect(page.locator("h1")).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PATH.replaceAll("/", "\\/")}$`));
  await expect(grid(page)).toHaveCount(48);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(2);
  await expect(page.locator('[data-gallery-feed-next]')).toBeHidden();
  await expect(page.locator('[data-gallery-grid="true"] > *')).toHaveCount(50);
  expect(await orderedIds(page)).toEqual(beforeIds);
  expect(await layoutMetadata(page, 0, 48)).toEqual(beforeMetadata);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __e2eNoReload?: string }
  ).__e2eNoReload ?? null)).toBe("alive");
  await expect(page.locator(
    `[data-gallery-grid="true"] [data-photo-card-media-wrapper] > a[href="${targetHref}"]`,
  )).toBeVisible();

  const after = await page.evaluate((href) => {
    const anchor = document.querySelector(`a[href="${href}"]`);
    return {
      scrollY: window.scrollY,
      top: anchor?.getBoundingClientRect().top ?? null,
    };
  }, targetHref);
  expect(after.top).not.toBeNull();
  expect(Math.abs(after.scrollY - before.scrollY)).toBeLessThan(240);
  expect(Math.abs(after.top! - before.top!)).toBeLessThan(240);
});

test("keeps the canonical next link with JavaScript disabled @smoke", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8788",
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await stubImageRequests(page);
    await page.goto(FIXTURE_PATH);
    await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
    const link = page.locator('[data-gallery-next-link="true"]');
    await expect(link).toHaveAttribute("href", PAGE_TWO_PATH);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${PAGE_TWO_PATH.replaceAll("/", "\\/")}$`));
    await expect(page.locator('[data-gallery-grid="true"] > li[data-photo-id]')).toHaveCount(24);
    await expect(page.locator("h1")).toContainText("#e2e-fixture");
  } finally {
    await context.close();
  }
});

test("keeps manual loading available when IntersectionObserver is absent @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "IntersectionObserver");
  });
  await page.goto(FIXTURE_PATH);
  await expect(grid(page)).toHaveCount(24);
  await expect(nextLink(page)).toBeVisible();
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(0);
  await expect(page.locator('[data-gallery-auto-load-sentinel="true"]')).toHaveCount(0);
  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);
  expect(await page.locator('[data-gallery-grid="true"] > *').count()).toBe(48);
  await expect(page).toHaveURL(new RegExp(`${FIXTURE_PATH.replaceAll("/", "\\/")}$`));
  await expect(status(page)).toHaveText("Loaded 24 photos.");
});

test("keeps the manual link visible when observer construction or observation fails @smoke", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: class {
        constructor(_callback: IntersectionObserverCallback) {
          throw new Error("observer construction failed");
        }
      },
    });
  });
  await page.goto(`${FIXTURE_PATH}?observer-failure=construction`);
  await expect(grid(page)).toHaveCount(24);
  await expect(nextLink(page)).toBeVisible();
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(0);
  await expect(page.locator('[data-gallery-auto-load-sentinel="true"]')).toHaveCount(0);
  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);

  await page.addInitScript(() => {
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: class {
        constructor(_callback: IntersectionObserverCallback) { /* no-op */ }
        observe(_target: Element): void {
          throw new Error("observer observation failed");
        }
        disconnect(): void { /* no-op */ }
      },
    });
  });
  await page.goto(`${FIXTURE_PATH}?observer-failure=observe`);
  await expect(grid(page)).toHaveCount(24);
  await expect(nextLink(page)).toBeVisible();
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(0);
  await expect(page.locator('[data-gallery-auto-load-sentinel="true"]')).toHaveCount(0);
  await nextLink(page).click();
  await expect(grid(page)).toHaveCount(48);
});

test("matches direct-page and appended absolute metadata in every non-Uniform layout @smoke", async ({ page }) => {
  await page.goto(FIXTURE_PATH);
  await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(24);
  await triggerIntersection(page, true);
  await expect(grid(page)).toHaveCount(48);

  const appended = new Map<string, Awaited<ReturnType<typeof layoutMetadata>>>();
  for (const layout of NON_UNIFORM_LAYOUTS) {
    await setRootLayout(page, layout);
    const metadata = await layoutMetadata(page, 24, 24);
    expect(metadata.every(({ role, aspect }) => /^g[fs][0-9a]$/.test(role) && Number(aspect) > 0)).toBe(true);
    appended.set(layout, metadata);
  }

  await page.goto(PAGE_TWO_PATH);
  await expect(grid(page)).toHaveCount(24);
  for (const layout of NON_UNIFORM_LAYOUTS) {
    await setRootLayout(page, layout);
    expect(await layoutMetadata(page, 0, 24)).toEqual(appended.get(layout));
  }
});

test("keeps ordered unique cards and safe short endings in every non-Uniform mode @smoke", async ({ page }) => {
  let initialIds: string[] = [];
  let incomingIds: string[] = [];
  await page.route(`**${PAGE_TWO_PATH}`, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    incomingIds = [...body.matchAll(/<li[^>]*data-photo-id="([^"]+)"/g)].map((match) => match[1] ?? "");
    if (initialIds.length === 0 || incomingIds.length === 0) {
      await route.fulfill({ response, body });
      return;
    }
    // The first incoming card duplicates an existing id while the rest retain
    // response order. The controller must consume the entire old tail and
    // append only the 23 unseen cards before building the next tail.
    const duplicateBody = body.replace(
      /(<li[^>]*data-photo-id=")[^"]+("[\s>])/,
      `$1${initialIds[0]}$2`,
    );
    incomingIds[0] = initialIds[0]!;
    await route.fulfill({ response, body: duplicateBody });
  });
  for (const layout of NON_UNIFORM_LAYOUTS) {
    // Give each loop its own history/snapshot identity. Revisiting the exact
    // same entry URL correctly restores the previous iteration's 50 cards.
    await page.goto(`${FIXTURE_PATH}?layout-case=${layout}`);
    await expect(grid(page)).toHaveCount(24);
    await setRootLayout(page, layout);
    initialIds = await orderedIds(page);
    await triggerIntersection(page, true);
    await expect(grid(page)).toHaveCount(47);
    await expect(page.locator('[data-gallery-loading-tile="true"]')).toHaveCount(2);
    const deduplicated = await orderedIds(page);
    expect(deduplicated.slice(0, initialIds.length)).toEqual(initialIds);
    expect(deduplicated.slice(initialIds.length)).toEqual(incomingIds.slice(1));
    expect(new Set(deduplicated).size).toBe(deduplicated.length);
    expect(await page.locator('[data-gallery-grid="true"] > *').count()).toBe(49);
    await triggerIntersection(page, false);
    await triggerIntersection(page, true);
    await expect(grid(page)).toHaveCount(49);
    const ids = await orderedIds(page);
    expect(ids.slice(0, initialIds.length)).toEqual(initialIds);
    expect(new Set(ids).size).toBe(ids.length);
    const geometry = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      directChildren: [...document.querySelectorAll('[data-gallery-grid="true"] > li[data-photo-id]')].length,
      allChildren: document.querySelector('[data-gallery-grid="true"]')?.children.length ?? -1,
      hiddenCopies: document.querySelectorAll('[data-gallery-grid="true"] [aria-hidden="true"][data-photo-id]').length,
      positiveTabindex: document.querySelectorAll('[data-gallery-grid="true"] [tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length,
      finalCards: [...document.querySelectorAll<HTMLElement>('[data-gallery-grid="true"] > li[data-photo-id]')]
        .slice(-2).map((card) => card.getBoundingClientRect().toJSON()),
    }));
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
    expect(geometry.directChildren).toBe(geometry.allChildren);
    expect(geometry).toMatchObject({ hiddenCopies: 0, positiveTabindex: 0 });
    expect(geometry.finalCards.every((rect) => rect.width > 0 && rect.height > 0)).toBe(true);
    expect(await page.locator('[data-gallery-loading-tile="true"]').count()).toBe(0);
    expect(await page.locator('[data-gallery-auto-load-sentinel="true"]').count()).toBe(0);
    expect(await page.locator('[data-gallery-feed-next]').count()).toBe(0);
  }
});

test("rejects old history and session snapshot versions instead of restoring their cards @smoke", async ({ page }) => {
  await page.goto(FIXTURE_PATH);
  await page.evaluate(() => {
    const feed = document.querySelector<HTMLElement>('[data-gallery-feed="true"]');
    if (!feed) throw new Error("gallery feed missing");
    const key = "gallery-old-version";
    const identity = { version: 1, key, scope: feed.dataset.galleryScope, url: location.href };
    history.replaceState({ ...(history.state ?? {}), zfbGallerySnapshot: identity }, "");
    const snapshot = {
      version: 1,
      key,
      scope: feed.dataset.galleryScope,
      entryUrl: location.href,
      page: 2,
      totalPages: 3,
      totalItems: 50,
      pageSize: 24,
      nextUrl: "/tags/e2e-fixture/page/3",
      nextCount: 2,
      terminal: false,
      photoIds: ["old-version-card"],
      cardsHtml: '<li data-photo-id="old-version-card" class="photo-card gf0" style="--a:1"><img src="/img/old.png"></li>',
      nextControlHtml: '<nav data-gallery-feed-next><a data-gallery-next-link="true" data-gallery-next-url="/tags/e2e-fixture/page/3" data-gallery-next-count="2" href="/tags/e2e-fixture/page/3">Load next 2 photos</a></nav>',
      savedAt: Date.now(),
    };
    sessionStorage.setItem(`zfb-gallery-snapshot:${key}`, JSON.stringify(snapshot));
    sessionStorage.setItem("zfb-gallery-snapshot:index", JSON.stringify([{ key, bytes: JSON.stringify(snapshot).length }]));
  });
  await page.reload();
  await expect(grid(page)).toHaveCount(24);
  await expect(page.locator('[data-photo-id="old-version-card"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state?.zfbGallerySnapshot?.version)).toBe(2);
});
