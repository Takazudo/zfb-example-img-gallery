import { describe, expect, it } from "vitest";
import {
  GallerySnapshotStore,
  GALLERY_HISTORY_STATE_KEY,
  GALLERY_SNAPSHOT_INDEX_KEY,
  GALLERY_SNAPSHOT_STORAGE_PREFIX,
  GALLERY_SNAPSHOT_VERSION,
  isGallerySnapshot,
  utf8ByteLength,
  type GallerySnapshot,
  type StorageLike,
} from "../../lib/gallery-snapshots";
import {
  GalleryAutoLoadGate,
  GallerySingleFlight,
  InfiniteGalleryController,
  identityFromState,
  isHtmlContentType,
  isSequentialFeed,
  parseFeedMetadata,
  refreshActiveGalleryFeed,
  stateWithGalleryIdentity,
  unseenPhotoIds,
  type FeedMetadata,
} from "../../lib/infinite-gallery";

const current: FeedMetadata = {
  scope: "global",
  page: 1,
  totalPages: 3,
  totalItems: 49,
  pageSize: 24,
  nextUrl: "/page/2",
  nextCount: 24,
  terminal: false,
};

function snapshot(key: string, overrides: Partial<GallerySnapshot> = {}): GallerySnapshot {
  return {
    version: GALLERY_SNAPSHOT_VERSION,
    key,
    scope: "global",
    entryUrl: "https://example.test/",
    page: 2,
    totalPages: 3,
    totalItems: 49,
    pageSize: 24,
    nextUrl: "/page/3",
    nextCount: 1,
    terminal: false,
    photoIds: ["1", "2"],
    cardsHtml: '<li data-photo-id="1"><img loading="lazy"></li><li data-photo-id="2"><img loading="lazy"></li>',
    nextControlHtml: '<nav data-gallery-feed-next><a data-gallery-next-link="true" href="/page/3">Next</a></nav>',
    savedAt: 123,
    ...overrides,
  };
}

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  throwOn: "get" | "set" | "remove" | null = null;
  failIndexWrite = false;

  getItem(key: string): string | null {
    if (this.throwOn === "get") throw new Error("blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOn === "set" || (this.failIndexWrite && key === GALLERY_SNAPSHOT_INDEX_KEY)) throw new Error("quota");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throwOn === "remove") throw new Error("blocked");
    this.values.delete(key);
  }
}

describe("infinite gallery response invariants", () => {
  it("accepts only complete, internally consistent feed metadata", () => {
    expect(parseFeedMetadata({
      galleryScope: "global",
      galleryPage: "2",
      galleryTotalPages: "3",
      galleryTotalItems: "49",
      galleryPageSize: "24",
      galleryNextUrl: "/page/3",
      galleryNextCount: "1",
      galleryTerminal: "false",
    })).toEqual({ ...current, page: 2, nextUrl: "/page/3", nextCount: 1 });
    expect(parseFeedMetadata({ ...{
      galleryScope: "global", galleryPage: "2", galleryTotalPages: "3",
      galleryTotalItems: "49", galleryPageSize: "24", galleryNextCount: "0",
      galleryNextUrl: "/page/3", galleryTerminal: "false",
    } })).toBeNull();
    expect(parseFeedMetadata({
      galleryScope: "global", galleryPage: "3", galleryTotalPages: "3",
      galleryTotalItems: "49", galleryPageSize: "24", galleryNextCount: "0",
      galleryNextUrl: "", galleryTerminal: "true",
    })?.terminal).toBe(true);
  });

  it("requires the exact next page, scope, and stable collection metadata", () => {
    const next = { ...current, page: 2, nextUrl: "/page/3", nextCount: 1 };
    expect(isSequentialFeed(current, next)).toBe(true);
    expect(isSequentialFeed(current, { ...next, page: 3 })).toBe(false);
    expect(isSequentialFeed(current, { ...next, scope: "tag:1" })).toBe(false);
    expect(isSequentialFeed(current, { ...next, totalItems: 50 })).toBe(false);
    expect(isSequentialFeed(current, { ...next, pageSize: 12 })).toBe(false);
  });

  it("accepts HTML media types case-insensitively and rejects every other response", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("APPLICATION/XHTML+XML")).toBe(true);
    expect(isHtmlContentType("application/json")).toBe(false);
    expect(isHtmlContentType(null)).toBe(false);
  });

  it("authoritatively replaces the active feed from the same personalized scope", async () => {
    const grid = {};
    let replacedWith: unknown = null;
    const feed = {
      dataset: {
        galleryScope: "favorites:7|viewer:7", galleryPage: "1", galleryTotalPages: "2",
        galleryTotalItems: "25", galleryPageSize: "24", galleryNextUrl: "/favorites/page/2",
        galleryNextCount: "1", galleryTerminal: "false",
      },
      querySelectorAll: (selector: string) => selector === '[data-gallery-grid="true"]' ? [grid] : [],
      replaceWith: (value: unknown) => { replacedWith = value; },
    };
    const incomingGrid = {};
    const incomingFeed = {
      dataset: { ...feed.dataset, galleryTotalItems: "24", galleryTotalPages: "1", galleryNextUrl: "", galleryNextCount: "0", galleryTerminal: "true" },
      querySelectorAll: (selector: string) => selector === '[data-gallery-grid="true"]' ? [incomingGrid] : [],
    };
    const document = {
      querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [feed] : [],
      importNode: (node: unknown) => node,
    };
    const incomingDocument = {
      querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [incomingFeed] : [],
    };
    await expect(refreshActiveGalleryFeed({
      document: document as unknown as Document,
      location: { href: "https://example.test/favorites", origin: "https://example.test" } as Location,
      fetch: (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch,
      parseHtml: () => incomingDocument as unknown as Document,
    })).resolves.toBe(true);
    expect(replacedWith).toBe(incomingFeed);
  });

  it("replaces a nonempty feed when the authoritative collection becomes empty", async () => {
    let replacedWith: unknown = null;
    const currentFeed = {
      dataset: {
        galleryScope: "favorites:7|viewer:7", galleryPage: "1", galleryTotalPages: "1",
        galleryTotalItems: "1", galleryPageSize: "24", galleryNextUrl: "",
        galleryNextCount: "0", galleryTerminal: "true",
      },
      replaceWith: (value: unknown) => { replacedWith = value; },
    };
    const emptyFeed = {
      dataset: {
        galleryScope: "favorites:7|viewer:7", galleryPage: "1", galleryTotalPages: "1",
        galleryTotalItems: "0", galleryPageSize: "24", galleryNextUrl: "",
        galleryNextCount: "0", galleryTerminal: "true",
      },
    };
    const document = {
      querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [currentFeed] : [],
      importNode: (node: unknown) => node,
    };
    const incomingDocument = {
      querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [emptyFeed] : [],
    };

    await expect(refreshActiveGalleryFeed({
      document: document as unknown as Document,
      location: { href: "https://example.test/favorites", origin: "https://example.test" } as Location,
      fetch: (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch,
      parseHtml: () => incomingDocument as unknown as Document,
    })).resolves.toBe(true);
    expect(replacedWith).toBe(emptyFeed);
  });

  it("deduplicates against rendered IDs and within the batch without changing order", () => {
    expect(unseenPhotoIds(["1", "2"], ["2", "3", "3", "4"])).toEqual(["3", "4"]);
  });

  it("requires an observer leave/re-enter after automatic success while manual loading stays independent", () => {
    const gate = new GalleryAutoLoadGate();
    expect(gate.observe(true)).toBe(true);
    gate.automaticSuccess();
    expect(gate.observe(true)).toBe(false);
    expect(gate.observe(false)).toBe(false);
    expect(gate.observe(true)).toBe(true);
  });

  it("shares one exact promise while a request is in flight and allows the next batch afterward", async () => {
    const flight = new GallerySingleFlight();
    let resolve!: (value: boolean) => void;
    let starts = 0;
    const first = flight.run(() => {
      starts += 1;
      return new Promise<boolean>((done) => { resolve = done; });
    });
    const duplicate = flight.run(async () => {
      starts += 1;
      return false;
    });
    expect(duplicate).toBe(first);
    expect(starts).toBe(1);
    resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(flight.run(async () => {
      starts += 1;
      return true;
    })).resolves.toBe(true);
    expect(starts).toBe(2);
  });
});

describe("infinite gallery controller without browser-only observers", () => {
  it("keeps manual retry operable and clears busy when preparation aborts its request", async () => {
    const OriginalHTMLElement = globalThis.HTMLElement;
    class FakeElement {
      dataset: Record<string, string> = {};
      children: FakeElement[] = [];
      innerHTML = "";
      outerHTML = "";
      textContent = "";
      hidden = true;
      href = "";
      loading = "";
      readonly attrs = new Map<string, string>();
      readonly listeners = new Map<string, Set<(event: Event) => void>>();
      queries = new Map<string, FakeElement | null>();
      queryLists = new Map<string, FakeElement[]>();
      querySelector(selector: string): FakeElement | null { return this.queries.get(selector) ?? null; }
      querySelectorAll(selector: string): FakeElement[] { return this.queryLists.get(selector) ?? []; }
      addEventListener(type: string, listener: (event: Event) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.get(type)?.delete(listener); }
      setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
      removeAttribute(name: string): void {
        this.attrs.delete(name);
        if (name === "href") this.href = "";
      }
      append(node: FakeElement): void { this.children.push(node); }
      appendChild(node: FakeElement): FakeElement {
        this.children.push(...node.children);
        return node;
      }
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });

    try {
      const grid = new FakeElement();
      const link = new FakeElement();
      link.href = "https://example.test/page/2";
      const status = new FakeElement();
      const control = new FakeElement();
      control.outerHTML = '<nav data-gallery-feed-next><a data-gallery-next-link="true" href="/page/2">Next</a></nav>';
      const feed = new FakeElement();
      feed.dataset = {
        galleryScope: "global", galleryPage: "1", galleryTotalPages: "2",
        galleryTotalItems: "48", galleryPageSize: "24", galleryNextUrl: "/page/2",
        galleryNextCount: "24", galleryTerminal: "false",
      };
      feed.queryLists.set('[data-gallery-grid="true"]', [grid]);
      feed.queries.set('[data-gallery-next-link="true"]', link);
      feed.queries.set("[data-gallery-status]", status);
      feed.queries.set("[data-gallery-feed-next]", control);

      const documentListeners = new Map<string, Set<(event: Event) => void>>();
      let activeFeed = feed;
      const fakeDocument = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [activeFeed] : [],
        addEventListener: (type: string, listener: (event: Event) => void) => {
          const listeners = documentListeners.get(type) ?? new Set();
          listeners.add(listener);
          documentListeners.set(type, listeners);
        },
        removeEventListener: (type: string, listener: (event: Event) => void) => documentListeners.get(type)?.delete(listener),
        dispatch: (event: Event) => documentListeners.get(event.type)?.forEach((listener) => listener(event)),
      };
      const history = { state: null };
      let requested = "";
      let failWithResponse = false;
      let succeed = false;
      let parsedDocument: unknown = null;
      const store = new GallerySnapshotStore(null);
      let syncedState: unknown = null;
      const controller = InfiniteGalleryController.mount({
        document: fakeDocument as unknown as Document,
        location: { href: "https://example.test/", origin: "https://example.test" } as Location,
        history: history as unknown as History,
        fetch: ((url: string | URL | Request, init?: RequestInit) => {
          requested = String(url);
          if (succeed) return Promise.resolve(new Response("ok", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }));
          if (failWithResponse) return Promise.resolve(new Response("error", {
            status: 503,
            headers: { "content-type": "text/html" },
          }));
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }) as typeof fetch,
        parseHtml: () => parsedDocument as Document,
        syncEntry: ((_url: string | URL, options?: { state?: unknown }) => {
          syncedState = options?.state ?? null;
        }) as typeof import("@takazudo/zfb-runtime").syncHistoryEntry,
        store,
      });
      expect(controller).not.toBeNull();
      const clickListener = [...(link.listeners.get("click") ?? [])][0]!;
      link.href = "https://example.test/wrong-page";
      let prevented = false;
      clickListener({
        type: "click", button: 0, defaultPrevented: false,
        metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
        preventDefault: () => { prevented = true; },
      } as unknown as Event);
      expect(prevented).toBe(false);
      link.href = "https://example.test/page/2";
      const loading = controller!.load("manual");
      expect(requested).toBe("https://example.test/page/2");
      expect(feed.attrs.get("aria-busy")).toBe("true");
      fakeDocument.dispatch({ type: "zfb:before-preparation" } as Event);
      expect(feed.attrs.has("aria-busy")).toBe(false);
      expect(status.textContent).toContain("Loading cancelled");
      expect(link.href).toBe("https://example.test/page/2");
      await expect(loading).resolves.toBe(false);
      failWithResponse = true;
      const gridBefore = grid.innerHTML;
      await expect(controller!.load("manual")).resolves.toBe(false);
      expect(status.textContent).toContain("Could not load photos");
      expect(grid.innerHTML).toBe(gridBefore);
      expect(link.href).toBe("https://example.test/page/2");

      const incomingGrid = new FakeElement();
      for (let id = 1; id <= 24; id += 1) {
        const card = new FakeElement();
        card.dataset.photoId = String(id);
        const image = new FakeElement();
        image.loading = "eager";
        card.queryLists.set("img", [image]);
        card.queries.set("img", image);
        incomingGrid.children.push(card);
      }
      const incomingFeed = new FakeElement();
      incomingFeed.dataset = {
        galleryScope: "global", galleryPage: "2", galleryTotalPages: "2",
        galleryTotalItems: "48", galleryPageSize: "24", galleryNextUrl: "",
        galleryNextCount: "0", galleryTerminal: "true",
      };
      incomingFeed.queryLists.set('[data-gallery-grid="true"]', [incomingGrid]);
      parsedDocument = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [incomingFeed] : [],
      };
      (fakeDocument as Record<string, unknown>).createDocumentFragment = () => new FakeElement();
      (fakeDocument as Record<string, unknown>).importNode = (node: FakeElement) => node;
      failWithResponse = false;
      succeed = true;
      await expect(controller!.load("manual")).resolves.toBe(true);
      expect(grid.children.map((card) => card.dataset.photoId)).toEqual(Array.from({ length: 24 }, (_, index) => String(index + 1)));
      expect(grid.children.every((card) => card.querySelectorAll("img").every((image) => image.loading === "lazy"))).toBe(true);
      expect(feed.dataset).toMatchObject({
        galleryPage: "2", galleryNextUrl: "", galleryNextCount: "0", galleryTerminal: "true",
      });
      expect(link.textContent).toBe("All photos loaded");
      expect(link.href).toBe("");
      expect(status.textContent).toBe("All photos loaded");

      const identity = identityFromState(syncedState, "global", "https://example.test/");
      expect(identity).not.toBeNull();
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.page).toBe(2);

      // Island cleanup runs after zfb swaps the body. A same-scope destination
      // must not overwrite the outgoing history entry's persisted snapshot.
      const destinationGrid = new FakeElement();
      const destinationCard = new FakeElement();
      destinationCard.dataset.photoId = "999";
      destinationGrid.children.push(destinationCard);
      const destinationFeed = new FakeElement();
      destinationFeed.dataset = {
        galleryScope: "global", galleryPage: "1", galleryTotalPages: "2",
        galleryTotalItems: "48", galleryPageSize: "24", galleryNextUrl: "/page/2",
        galleryNextCount: "24", galleryTerminal: "false",
      };
      destinationFeed.queryLists.set('[data-gallery-grid="true"]', [destinationGrid]);
      activeFeed = destinationFeed;
      controller!.destroy();
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.page).toBe(2);
    } finally {
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: OriginalHTMLElement });
    }
  });
});

describe("gallery entry identity and bounded snapshots", () => {
  it("merges a unique gallery identity without overwriting router-owned state", () => {
    const identity = {
      version: GALLERY_SNAPSHOT_VERSION,
      key: "gallery-12345678",
      scope: "global",
      url: "https://example.test/",
    } as const;
    const state = stateWithGalleryIdentity({ index: 7, scrollX: 12, scrollY: 345, modal: true }, identity);
    expect(state).toEqual({
      index: 7, scrollX: 12, scrollY: 345, modal: true,
      [GALLERY_HISTORY_STATE_KEY]: identity,
    });
    expect(identityFromState(state, "global")).toEqual(identity);
    expect(identityFromState(state, "tag:1")).toBeNull();
    expect(identityFromState(state, "global", "https://example.test/other")).toBeNull();
  });

  it("validates schema version, collection, terminal fields, and unique IDs", () => {
    expect(isGallerySnapshot(snapshot("gallery-12345678"), { scope: "global" })).toBe(true);
    expect(isGallerySnapshot(snapshot("gallery-12345678", { version: 2 as 1 }))).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678"), { scope: "tag:1" })).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678"), { entryUrl: "https://example.test/other" })).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678", { photoIds: ["1", "1"] }))).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678", { photoIds: [], cardsHtml: "" }))).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678", {
      totalItems: 1,
      photoIds: ["1", "2"],
    }))).toBe(false);
    expect(isGallerySnapshot(snapshot("gallery-12345678", { terminal: true }))).toBe(false);
  });

  it("uses memory as an LRU and evicts the oldest entry at the explicit count cap", () => {
    const store = new GallerySnapshotStore(null, { maxEntries: 2 });
    store.set(snapshot("gallery-00000001"));
    store.set(snapshot("gallery-00000002"));
    expect(store.get("gallery-00000001", "global")?.key).toBe("gallery-00000001");
    store.set(snapshot("gallery-00000003"));
    expect(store.memoryKeys()).toEqual(["gallery-00000001", "gallery-00000003"]);
    expect(store.get("gallery-00000002", "global")).toBeNull();
  });

  it("rejects an oversized record without evicting a valid live record", () => {
    const store = new GallerySnapshotStore(null, { maxEntryBytes: 500 });
    expect(store.set(snapshot("gallery-00000001", { cardsHtml: "x" }))).toBe(true);
    expect(store.set(snapshot("gallery-00000002", { cardsHtml: "x".repeat(1000) }))).toBe(false);
    expect(store.memoryKeys()).toEqual(["gallery-00000001"]);
  });

  it("persists an oldest-first index and removes evicted session records", () => {
    const storage = new MemoryStorage();
    const store = new GallerySnapshotStore(storage, { maxEntries: 2 });
    store.set(snapshot("gallery-00000001"));
    store.set(snapshot("gallery-00000002"));
    store.set(snapshot("gallery-00000003"));
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`)).toBe(false);
    expect(JSON.parse(storage.values.get(GALLERY_SNAPSHOT_INDEX_KEY) ?? "[]").map((item: { key: string }) => item.key))
      .toEqual(["gallery-00000002", "gallery-00000003"]);
  });

  it("invalidates every bounded memory and session snapshot after personalized writes", () => {
    const storage = new MemoryStorage();
    const store = new GallerySnapshotStore(storage);
    store.set(snapshot("gallery-00000001"));
    store.set(snapshot("gallery-00000002", { scope: "tag:1|viewer:7" }));
    expect(store.memoryKeys()).toHaveLength(2);
    store.invalidateAll();
    expect(store.memoryKeys()).toEqual([]);
    expect(storage.values.has(GALLERY_SNAPSHOT_INDEX_KEY)).toBe(false);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`)).toBe(false);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000002`)).toBe(false);
  });

  it("restores from session storage and rejects corrupt or mismatched fallback data", () => {
    const storage = new MemoryStorage();
    storage.setItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`, JSON.stringify(snapshot("gallery-00000001")));
    expect(new GallerySnapshotStore(storage).get("gallery-00000001", "global")?.page).toBe(2);
    expect(new GallerySnapshotStore(storage).get("gallery-00000001", "global", "https://example.test/other")).toBeNull();
    expect(new GallerySnapshotStore(storage).get("gallery-00000001", "tag:1")).toBeNull();
    storage.setItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000002`, "{bad json");
    expect(new GallerySnapshotStore(storage).get("gallery-00000002", "global")).toBeNull();
  });

  it("degrades safely when storage APIs throw on reads, writes, or quota", () => {
    const storage = new MemoryStorage();
    storage.throwOn = "set";
    const store = new GallerySnapshotStore(storage);
    expect(store.set(snapshot("gallery-00000001"))).toBe(true);
    expect(store.get("gallery-00000001", "global")?.key).toBe("gallery-00000001");
    storage.throwOn = "get";
    expect(new GallerySnapshotStore(storage).get("gallery-00000009", "global")).toBeNull();
  });

  it("removes a new session record when its bounded-index write fails", () => {
    const storage = new MemoryStorage();
    storage.failIndexWrite = true;
    const store = new GallerySnapshotStore(storage);
    expect(store.set(snapshot("gallery-00000001"))).toBe(true);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`)).toBe(false);
    expect(store.get("gallery-00000001", "global")?.key).toBe("gallery-00000001");
  });

  it("recomputes indexed record bytes instead of trusting corrupt size claims", () => {
    const storage = new MemoryStorage();
    const first = JSON.stringify(snapshot("gallery-00000001"));
    const second = JSON.stringify(snapshot("gallery-00000002"));
    storage.setItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`, first);
    storage.setItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000002`, second);
    storage.setItem(GALLERY_SNAPSHOT_INDEX_KEY, JSON.stringify([
      { key: "gallery-00000001", bytes: 1 },
      { key: "gallery-00000002", bytes: 1 },
    ]));
    const perEntryBytes = utf8ByteLength(first);
    const store = new GallerySnapshotStore(storage, {
      maxEntries: 5,
      maxEntryBytes: perEntryBytes + 20,
      maxTotalBytes: perEntryBytes * 2 + 20,
    });
    expect(store.set(snapshot("gallery-00000003"))).toBe(true);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000001`)).toBe(false);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000002`)).toBe(true);
    expect(storage.values.has(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}gallery-00000003`)).toBe(true);
  });
});
