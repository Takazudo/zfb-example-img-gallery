import { describe, expect, it, vi } from "vitest";
import {
  FAVORITE_FAILURE_MESSAGE,
  FAVORITE_SUCCESS_MESSAGE,
  FAVORITE_TOAST_DURATION_MS,
  FavoriteController,
  UNFAVORITE_SUCCESS_MESSAGE,
  favoriteCountLabel,
  parseFavoriteResult,
} from "../../lib/favorite-controller";

class FakeClassList {
  readonly values = new Set<string>();
  toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name); else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  dataset: Record<string, string> = {};
  textContent = "";
  disabled = false;
  value = "";
  readonly attributes = new Map<string, string>();
  readonly classList = new FakeClassList();
  readonly queries = new Map<string, FakeElement | null>();
  readonly queryLists = new Map<string, FakeElement[]>();
  tagName = "DIV";
  matches(selector: string): boolean {
    if (selector === "[data-favorite-form]") return this.dataset.favoriteForm !== undefined;
    if (selector === "form") return this.tagName === "FORM";
    return false;
  }
  querySelector<T>(selector: string): T | null { return (this.queries.get(selector) ?? null) as T | null; }
  querySelectorAll<T>(selector: string): T[] { return (this.queryLists.get(selector) ?? []) as T[]; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  toggleAttribute(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.attributes.has(name);
    if (enabled) this.attributes.set(name, ""); else this.attributes.delete(name);
    return enabled;
  }
}

function control(photoId: number, favorited = false) {
  const form = new FakeElement();
  form.tagName = "FORM";
  form.dataset = { favoriteForm: "true", favoriteControl: "true", photoId: String(photoId), favoriteState: favorited ? "favorited" : "unfavorited" };
  const id = new FakeElement(); id.value = String(photoId);
  const state = new FakeElement(); state.value = favorited ? "unfavorited" : "favorited";
  const button = new FakeElement();
  button.setAttribute("aria-label", `${favorited ? "Remove" : "Add"} Photo ${favorited ? "from" : "to"} favorites`);
  const path = new FakeElement(); path.setAttribute("fill", favorited ? "currentColor" : "none");
  form.queries.set('input[name="photoId"]', id);
  form.queries.set('input[name="state"]', state);
  form.queries.set('button[type="submit"]', button);
  form.queries.set("[data-favorite-star-path]", path);
  form.queryLists.set('button[type="submit"]', [button]);
  return { form, state, button, path };
}

function harness(options: {
  favoritesFeed?: boolean;
  response?: Response | Promise<Response>;
  refreshSuccess?: boolean;
  refreshReject?: boolean;
} = {}) {
  const controls = [control(7), control(7)];
  const count = new FakeElement();
  count.dataset = { favoriteCount: "true", photoId: "7", favoriteCountValue: "2" };
  count.textContent = "2 favorites";
  const feed = new FakeElement();
  feed.dataset.galleryScope = options.favoritesFeed ? "favorites:3|viewer:3" : "global|viewer:3";
  const listeners = new Map<string, { listener: (event: Event) => void; capture: boolean }>();
  const document = {
    addEventListener(type: string, listener: (event: Event) => void, capture?: boolean) {
      listeners.set(type, { listener, capture: capture === true });
    },
    removeEventListener: vi.fn(),
    querySelectorAll(selector: string) {
      if (selector.startsWith("[data-favorite-form]")) return controls.map((item) => item.form);
      if (selector.startsWith("[data-favorite-control]")) return controls.map((item) => item.form);
      if (selector.startsWith("[data-favorite-count]")) return [count];
      return [];
    },
    querySelector(selector: string) { return selector === '[data-gallery-feed="true"]' ? feed : null; },
  } as unknown as Document;
  const toast = new FakeElement();
  const timerCallbacks: Array<() => void> = [];
  const invalidateAll = vi.fn();
  const refreshFavoritesFeed = vi.fn(async () => {
    if (options.refreshReject) throw new Error("refresh failed after mutation");
    return options.refreshSuccess ?? true;
  });
  const fetchMock = vi.fn(async () => options.response ?? new Response(JSON.stringify({ photoId: 7, favorited: true, favoriteCount: 3 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const controller = new FavoriteController({
    document,
    fetch: fetchMock as typeof fetch,
    snapshotStore: { invalidateAll },
    toast: toast as unknown as HTMLElement,
    setTimer: ((callback: () => void) => { timerCallbacks.push(callback); return timerCallbacks.length; }) as typeof setTimeout,
    clearTimer: vi.fn() as unknown as typeof clearTimeout,
    refreshFavoritesFeed,
  });
  const submit = (form = controls[0]!.form) => {
    const event = {
      target: form,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as Event;
    listeners.get("submit")!.listener(event);
    return event as Event & { preventDefault: ReturnType<typeof vi.fn>; stopImmediatePropagation: ReturnType<typeof vi.fn> };
  };
  return { controller, controls, count, toast, timerCallbacks, invalidateAll, refreshFavoritesFeed, fetchMock, listeners, submit };
}

describe("favorite controller", () => {
  it("parses only authoritative DTOs and pluralizes counts", () => {
    expect(parseFavoriteResult({ photoId: 7, favorited: true, favoriteCount: 2 }, 7)).toEqual({ photoId: 7, favorited: true, favoriteCount: 2 });
    expect(parseFavoriteResult({ photoId: 8, favorited: true, favoriteCount: 2 }, 7)).toBeNull();
    expect(parseFavoriteResult({ photoId: 7, favorited: true, favoriteCount: -1 }, 7)).toBeNull();
    expect(favoriteCountLabel(1)).toBe("1 favorite");
    expect(favoriteCountLabel(2)).toBe("2 favorites");
  });

  it("intercepts in capture phase, suppresses duplicate writes, and synchronizes initial and appended controls", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const h = harness({ response: pending });
    expect(h.listeners.get("submit")?.capture).toBe(true);
    const first = h.submit();
    const duplicate = h.submit(h.controls[1]!.form);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.controller.pendingCount).toBe(1);
    resolve(new Response(JSON.stringify({ photoId: 7, favorited: true, favoriteCount: 3 }), { status: 200 }));
    await h.controller.settled();
    for (const item of h.controls) {
      expect(item.form.dataset.favoriteState).toBe("favorited");
      expect(item.state.value).toBe("unfavorited");
      expect(item.button.attributes.get("aria-pressed")).toBe("true");
      expect(item.path.attributes.get("fill")).toBe("currentColor");
    }
    expect(h.count.textContent).toBe("3 favorites");
    expect(h.invalidateAll).toHaveBeenCalledOnce();
    expect(h.toast.textContent).toBe(FAVORITE_SUCCESS_MESSAGE);
    expect(h.timerCallbacks).toHaveLength(1);
    h.timerCallbacks[0]!();
    expect(h.toast.dataset.visible).toBe("false");
    expect(h.timerCallbacks).toHaveLength(2);
    h.timerCallbacks[1]!();
    expect(h.toast.textContent).toBe("");
    expect(FAVORITE_TOAST_DURATION_MS).toBe(2_500);
  });

  it("retains prior state on failure and announces the error", async () => {
    const h = harness({ response: new Response("no", { status: 503 }) });
    h.submit();
    await h.controller.settled();
    expect(h.controls[0]!.form.dataset.favoriteState).toBe("unfavorited");
    expect(h.controls[0]!.path.attributes.get("fill")).toBe("none");
    expect(h.invalidateAll).not.toHaveBeenCalled();
    expect(h.toast.textContent).toBe(FAVORITE_FAILURE_MESSAGE);
  });

  it("refreshes an active Favorites feed after authoritative removal", async () => {
    const h = harness({
      favoritesFeed: true,
      response: new Response(JSON.stringify({ photoId: 7, favorited: false, favoriteCount: 1 }), { status: 200 }),
    });
    h.controls.forEach((item) => {
      item.form.dataset.favoriteState = "favorited";
      item.state.value = "unfavorited";
      item.button.setAttribute("aria-label", "Remove Photo from favorites");
    });
    h.submit();
    await h.controller.settled();
    expect(h.refreshFavoritesFeed).toHaveBeenCalledOnce();
    expect(h.toast.textContent).toBe(UNFAVORITE_SUCCESS_MESSAGE);
  });

  it("does not misreport a confirmed removal when only feed reconciliation fails", async () => {
    const h = harness({
      favoritesFeed: true,
      refreshSuccess: false,
      response: new Response(JSON.stringify({ photoId: 7, favorited: false, favoriteCount: 1 }), { status: 200 }),
    });
    h.controls[0]!.state.value = "unfavorited";
    h.submit();
    await h.controller.settled();
    expect(h.refreshFavoritesFeed).toHaveBeenCalledOnce();
    expect(h.toast.textContent).toBe(UNFAVORITE_SUCCESS_MESSAGE);
  });

  it("does not misreport a confirmed removal when feed reconciliation throws", async () => {
    const h = harness({
      favoritesFeed: true,
      refreshReject: true,
      response: new Response(JSON.stringify({ photoId: 7, favorited: false, favoriteCount: 1 }), { status: 200 }),
    });
    h.controls[0]!.state.value = "unfavorited";
    h.submit();
    await h.controller.settled();
    expect(h.refreshFavoritesFeed).toHaveBeenCalledOnce();
    expect(h.toast.textContent).toBe(UNFAVORITE_SUCCESS_MESSAGE);
  });
});
