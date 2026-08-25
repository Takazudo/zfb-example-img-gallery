import type { GallerySnapshotStore } from "./gallery-snapshots";

export const FAVORITE_SUCCESS_MESSAGE = "You made this a favorite!";
export const UNFAVORITE_SUCCESS_MESSAGE = "Removed from favorites.";
export const FAVORITE_FAILURE_MESSAGE = "Could not update favorite. Please try again.";
export const FAVORITE_TOAST_DURATION_MS = 2_500;

type FavoriteResult = { photoId: number; favorited: boolean; favoriteCount: number };

export function favoriteCountLabel(count: number): string {
  return `${count} ${count === 1 ? "favorite" : "favorites"}`;
}

export function parseFavoriteResult(value: unknown, expectedPhotoId: number): FavoriteResult | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  return result.photoId === expectedPhotoId
    && typeof result.favorited === "boolean"
    && typeof result.favoriteCount === "number"
    && Number.isSafeInteger(result.favoriteCount)
    && result.favoriteCount >= 0
    ? result as FavoriteResult
    : null;
}

export type FavoriteControllerEnvironment = {
  document: Document;
  fetch: typeof fetch;
  snapshotStore: Pick<GallerySnapshotStore, "invalidateAll">;
  toast: HTMLElement;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  refreshFavoritesFeed?: () => Promise<boolean>;
};

function defaultEnvironment(
  toast: HTMLElement,
  snapshotStore: Pick<GallerySnapshotStore, "invalidateAll">,
  refreshFavoritesFeed?: () => Promise<boolean>,
): FavoriteControllerEnvironment | null {
  if (typeof document === "undefined" || typeof fetch === "undefined") return null;
  return {
    document,
    fetch: globalThis.fetch.bind(globalThis),
    snapshotStore,
    toast,
    // Window timer methods can enforce a receiver brand check when invoked as
    // environment-object methods; bind them to the browser global once.
    setTimer: globalThis.setTimeout.bind(globalThis),
    clearTimer: globalThis.clearTimeout.bind(globalThis),
    ...(refreshFavoritesFeed ? { refreshFavoritesFeed } : {}),
  };
}

function currentFormState(form: HTMLFormElement): { photoId: number; desired: "favorited" | "unfavorited" } | null {
  const rawId = form.querySelector<HTMLInputElement>('input[name="photoId"]')?.value;
  const desired = form.querySelector<HTMLInputElement>('input[name="state"]')?.value;
  if (!rawId || !/^[1-9]\d{0,14}$/.test(rawId)) return null;
  if (desired !== "favorited" && desired !== "unfavorited") return null;
  return { photoId: Number(rawId), desired };
}

function setPending(document: Document, photoId: number, pending: boolean): void {
  document.querySelectorAll<HTMLElement>(`[data-favorite-form][data-photo-id="${photoId}"]`).forEach((control) => {
    control.toggleAttribute("aria-busy", pending);
    control.querySelectorAll<HTMLButtonElement>('button[type="submit"]').forEach((button) => {
      button.disabled = pending;
    });
  });
}

export function applyFavoriteResult(document: Document, result: FavoriteResult): void {
  const state = result.favorited ? "favorited" : "unfavorited";
  document.querySelectorAll<HTMLElement>(`[data-favorite-control][data-photo-id="${result.photoId}"]`).forEach((control) => {
    if (!control.matches("form")) return;
    control.dataset.favoriteState = state;
    const button = control.querySelector<HTMLButtonElement>('button[type="submit"]');
    const input = control.querySelector<HTMLInputElement>('input[name="state"]');
    const path = control.querySelector<SVGPathElement>("[data-favorite-star-path]");
    if (button) {
      button.setAttribute("aria-pressed", String(result.favorited));
      const priorLabel = button.getAttribute("aria-label") ?? "";
      const title = priorLabel
        .replace(/^(?:Add|Remove) /, "")
        .replace(/ (?:to|from) favorites$/, "");
      button.setAttribute("aria-label", `${result.favorited ? "Remove" : "Add"} ${title} ${result.favorited ? "from" : "to"} favorites`);
      button.classList.toggle("text-accent", result.favorited);
      button.classList.toggle("text-ink", !result.favorited);
    }
    if (input) input.value = result.favorited ? "unfavorited" : "favorited";
    path?.setAttribute("fill", result.favorited ? "currentColor" : "none");
  });
  document.querySelectorAll<HTMLElement>(`[data-favorite-count][data-photo-id="${result.photoId}"]`).forEach((count) => {
    count.dataset.favoriteCountValue = String(result.favoriteCount);
    count.textContent = favoriteCountLabel(result.favoriteCount);
  });
}

function activeFeedIsFavorites(document: Document): boolean {
  const scope = document.querySelector<HTMLElement>('[data-gallery-feed="true"]')?.dataset.galleryScope;
  return typeof scope === "string" && scope.startsWith("favorites:");
}

export class FavoriteController {
  readonly #env: FavoriteControllerEnvironment;
  readonly #pending = new Map<number, Promise<void>>();
  #toastTimer: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  static mount(
    toast: HTMLElement,
    snapshotStore: Pick<GallerySnapshotStore, "invalidateAll">,
    refreshFavoritesFeed?: () => Promise<boolean>,
  ): FavoriteController | null {
    const environment = defaultEnvironment(toast, snapshotStore, refreshFavoritesFeed);
    return environment ? new FavoriteController(environment) : null;
  }

  constructor(environment: FavoriteControllerEnvironment) {
    this.#env = environment;
    environment.document.addEventListener("submit", this.#onSubmit, true);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending.values());
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#env.document.removeEventListener("submit", this.#onSubmit, true);
    if (this.#toastTimer !== null) this.#env.clearTimer(this.#toastTimer);
  }

  readonly #onSubmit = (event: Event): void => {
    const form = event.target as HTMLFormElement | null;
    if (!form?.matches?.("[data-favorite-form]")) return;
    const state = currentFormState(form);
    // Malformed markup keeps the ordinary POST fallback rather than being
    // swallowed by a broken enhancement.
    if (!state) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.#pending.has(state.photoId)) return;
    const task = this.#mutate(state.photoId, state.desired).finally(() => {
      this.#pending.delete(state.photoId);
      setPending(this.#env.document, state.photoId, false);
    });
    this.#pending.set(state.photoId, task);
    setPending(this.#env.document, state.photoId, true);
  };

  async #mutate(photoId: number, desired: "favorited" | "unfavorited"): Promise<void> {
    try {
      const response = await this.#env.fetch("/favorites", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ photoId, state: desired }),
      });
      if (!response.ok) throw new Error("Favorite request failed");
      const result = parseFavoriteResult(await response.json(), photoId);
      if (!result) throw new Error("Invalid favorite response");
      applyFavoriteResult(this.#env.document, result);
      this.#env.snapshotStore.invalidateAll();
      this.#showToast(result.favorited ? FAVORITE_SUCCESS_MESSAGE : UNFAVORITE_SUCCESS_MESSAGE);
      if (!result.favorited && activeFeedIsFavorites(this.#env.document)) {
        // The mutation is already authoritative. A secondary refresh failure
        // must not relabel that successful write as a mutation failure; the
        // destroyed infinite controller leaves the normal page link fallback.
        try {
          await this.#env.refreshFavoritesFeed?.();
        } catch {
          // Preserve the successful mutation and toast if reconciliation fails.
        }
      }
    } catch {
      this.#showToast(FAVORITE_FAILURE_MESSAGE);
    }
  }

  #showToast(message: string): void {
    if (this.#toastTimer !== null) this.#env.clearTimer(this.#toastTimer);
    this.#env.toast.textContent = message;
    this.#env.toast.dataset.visible = "true";
    this.#toastTimer = this.#env.setTimer(() => {
      this.#env.toast.dataset.visible = "false";
      this.#toastTimer = this.#env.setTimer(() => {
        this.#env.toast.textContent = "";
        this.#toastTimer = null;
      }, 200);
    }, FAVORITE_TOAST_DURATION_MS);
  }
}
