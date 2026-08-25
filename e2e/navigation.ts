import { expect, type Page } from "@playwright/test";

const PROBE_KEY = "__zfbThemeNavigationProbe";
const TARGET_ATTRIBUTE = "data-e2e-navigation-target";
const TARGET_VALUE = "theme-navigation";

export type SoftNavigationResult = {
  finalUrl: string;
  swapCount: number;
};

type NavigationProbe = {
  done: boolean;
  count: number;
  cleanup: () => void;
};

type ProbeTarget = {
  kind: "anchor" | "form";
  url: string;
};

/**
 * Arm the lifecycle probe before an action which should produce one swap.
 *
 * The completion listener is one-shot so the wait is tied to the first real
 * swap event. A second listener counts every event until the result is read,
 * which keeps the contract strict without racing the trigger.
 */
async function armSwapProbe(page: Page, target: ProbeTarget): Promise<void> {
  await page.evaluate(
    ({ attribute, key, marker, target }) => {
      const destination = new URL(target.url, window.location.href);
      if (destination.origin !== window.location.origin) {
        throw new Error(`Soft navigation only accepts same-origin URLs: ${target.url}`);
      }

      const element =
        target.kind === "anchor"
          ? [...document.querySelectorAll("a[href]")].find((candidate) => {
              if (!(candidate instanceof HTMLAnchorElement)) return false;
              const candidateTarget = candidate.getAttribute("target");
              return (
                new URL(candidate.href, window.location.href).href === destination.href &&
                (!candidateTarget || candidateTarget === "_self")
              );
            })
          : [...document.querySelectorAll("form[action]")].find((candidate) => {
              if (!(candidate instanceof HTMLFormElement)) return false;
              return new URL(candidate.action, window.location.href).href === destination.href;
            });

      if (
        !(element instanceof HTMLAnchorElement) &&
        !(element instanceof HTMLFormElement)
      ) {
        throw new Error(`Could not find same-origin ${target.kind} for ${target.url}`);
      }
      element.setAttribute(attribute, marker);

      const previous = (window as unknown as Record<string, NavigationProbe | undefined>)[key];
      previous?.cleanup();

      const probe: NavigationProbe = {
        done: false,
        count: 0,
        cleanup: () => {},
      };
      const countSwap = () => {
        probe.count += 1;
      };
      const complete = () => {
        probe.done = true;
      };
      probe.cleanup = () => {
        document.removeEventListener("zfb:after-swap", countSwap);
        document.removeEventListener("zfb:after-swap", complete);
      };

      // Both listeners are installed before the caller clicks or submits.
      document.addEventListener("zfb:after-swap", countSwap);
      document.addEventListener("zfb:after-swap", complete, { once: true });
      (window as unknown as Record<string, NavigationProbe>)[key] = probe;

      // For GET links the discovery, listener installation, sentinel setup,
      // and click are one browser evaluation. No event can win a round trip.
      if (target.kind === "anchor") {
        (element as HTMLAnchorElement).click();
      }
    },
    { attribute: TARGET_ATTRIBUTE, key: PROBE_KEY, marker: TARGET_VALUE, target },
  );
}

async function finishSwapProbe(page: Page): Promise<SoftNavigationResult> {
  await page.waitForFunction((key) => {
    const probe = (window as unknown as Record<string, NavigationProbe | undefined>)[key];
    return probe?.done === true;
  }, PROBE_KEY);

  const result = await page.evaluate((key) => {
    const probes = window as unknown as Record<string, NavigationProbe | undefined>;
    const probe = probes[key];
    const result = {
      finalUrl: window.location.href,
      swapCount: probe?.count ?? 0,
    };
    probe?.cleanup();
    delete probes[key];
    return result;
  }, PROBE_KEY);

  // A GET or mutation action under test must produce exactly one DOM swap.
  expect(result.swapCount).toBe(1);
  return result;
}

/** Click an intended same-origin anchor and wait for exactly one soft swap. */
export async function softClick(page: Page, href: string): Promise<SoftNavigationResult> {
  await armSwapProbe(page, { kind: "anchor", url: href });
  return finishSwapProbe(page);
}

/** Submit an intended same-origin form and wait for exactly one soft swap. */
export async function softSubmit(
  page: Page,
  action: string,
  submitterName: string,
): Promise<SoftNavigationResult> {
  await armSwapProbe(page, { kind: "form", url: action });

  const form = page.locator(`form[${TARGET_ATTRIBUTE}="${TARGET_VALUE}"]`);
  const submitter = form.getByRole("button", { name: submitterName });
  await expect(submitter).toBeVisible();
  await submitter.click();
  return finishSwapProbe(page);
}

/** Open the account popover when it is not already visible. */
export async function ensureAccountMenuOpen(page: Page): Promise<void> {
  const menu = page.locator("#account-menu");
  if (await menu.isVisible()) return;

  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await expect(menu).toBeVisible();
}
