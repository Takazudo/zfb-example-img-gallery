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
  captureGallerySnapshot,
  identityFromState,
  injectGallerySnapshot,
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

  it("re-arms after observer exit or explicit continuation input without automatic cascading", () => {
    const gate = new GalleryAutoLoadGate();
    expect(gate.observe(true)).toBe(true);
    gate.automaticSuccess();
    expect(gate.observe(true)).toBe(false);
    gate.continueAfterInput();
    expect(gate.observe(true)).toBe(true);
    gate.automaticSuccess();
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

  it("serializes only photo cards and round-trips without non-element grid children", () => {
    const OriginalHTMLElement = globalThis.HTMLElement;
    class SnapshotElement {
      dataset: Record<string, string> = {};
      children: unknown[] = [];
      outerHTML = "";
      attributes: { name: string; value: string }[] = [];
      tagName = "LI";
      ownerDocument: unknown;
      querySelector(selector: string): SnapshotElement | null {
        return selector === "img" ? new SnapshotElement() : null;
      }
      querySelectorAll(): SnapshotElement[] { return []; }
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: SnapshotElement });

    try {
      const makeCard = (id: string): SnapshotElement => {
        const card = new SnapshotElement();
        card.dataset.photoId = id;
        card.outerHTML = `<li data-photo-id="${id}"><img></li>`;
        return card;
      };
      const sourceGrid = { children: [makeCard("1"), new SnapshotElement(), makeCard("2")] };
      const sourceFeed = {
        dataset: {
          galleryScope: "global", galleryPage: "1", galleryTotalPages: "1",
          galleryTotalItems: "2", galleryPageSize: "24", galleryNextUrl: "",
          galleryNextCount: "0", galleryTerminal: "true",
        },
        querySelectorAll: (selector: string) => selector === '[data-gallery-grid="true"]' ? [sourceGrid] : [],
        querySelector: () => null,
      };
      const sourceRoot = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [sourceFeed] : [],
      };
      const identity = {
        version: GALLERY_SNAPSHOT_VERSION,
        key: "gallery-12345678",
        scope: "global",
        url: "https://example.test/",
      } as const;
      const captured = captureGallerySnapshot(sourceRoot as unknown as ParentNode, identity, 123);
      expect(captured?.cardsHtml).toBe('<li data-photo-id="1"><img></li><li data-photo-id="2"><img></li>');

      const destinationGrid = {
        children: [] as SnapshotElement[],
        querySelectorAll: () => [],
        replaceChildren(fragment: { children: SnapshotElement[] }) { this.children = [...fragment.children]; },
      };
      let serializedTextNode = false;
      const ownerDocument = {
        createElement: () => {
          const template = {
            content: { children: [] as unknown[], firstElementChild: null },
            set innerHTML(value: string) {
              this.content.children = [...value.matchAll(/data-photo-id="([^"]+)"/g)].map((match) => makeCard(match[1]!));
              if (serializedTextNode) this.content.children.push({});
            },
          };
          return template;
        },
      };
      const destinationFeed = {
        dataset: { ...sourceFeed.dataset },
        ownerDocument,
        removeAttribute: () => undefined,
        querySelectorAll: (selector: string) => selector === '[data-gallery-grid="true"]' ? [destinationGrid] : [],
        querySelector: () => null,
      };
      const destinationRoot = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [destinationFeed] : [],
      };
      expect(injectGallerySnapshot(destinationRoot as unknown as ParentNode, captured!)).toBe(true);
      expect(destinationGrid.children.map((card) => card.dataset.photoId)).toEqual(["1", "2"]);

      destinationGrid.children = [];
      serializedTextNode = true;
      expect(injectGallerySnapshot(destinationRoot as unknown as ParentNode, captured!)).toBe(false);
      expect(destinationGrid.children).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: OriginalHTMLElement });
    }
  });
});

describe("infinite gallery controller without browser-only observers", () => {
  it("keeps manual retry operable and clears busy when preparation aborts its request", async () => {
    const OriginalHTMLElement = globalThis.HTMLElement;
    class FakeElement {
      dataset: Record<string, string> = {};
      children: FakeElement[] = [];
      parentNode: FakeElement | null = null;
      ownerDocument: { createElement: (tagName: string) => FakeElement } | null = null;
      tagName = "DIV";
      className = "";
      innerHTML = "";
      outerHTML = "";
      textContent = "";
      hidden = true;
      href = "";
      loading = "";
      readonly attrs = new Map<string, string>();
      readonly listeners = new Map<string, Set<(event: Event) => void>>();
      readonly animations: { keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: () => void; cancelled: boolean }[] = [];
      readonly styleValues = new Map<string, string>();
      readonly style = {
        getPropertyValue: (name: string) => this.styleValues.get(name) ?? "",
        setProperty: (name: string, value: string) => { this.styleValues.set(name, value); },
      };
      queries = new Map<string, FakeElement | null>();
      queryLists = new Map<string, FakeElement[]>();
      querySelector(selector: string): FakeElement | null {
        if (this.queries.has(selector)) return this.queries.get(selector) ?? null;
        return this.querySelectorAll(selector)[0] ?? null;
      }
      querySelectorAll(selector: string): FakeElement[] {
        if (this.queryLists.has(selector)) return this.queryLists.get(selector) ?? [];
        const matches = (node: FakeElement): boolean => {
          if (selector === '[data-gallery-loading-tile="true"]') return node.dataset.galleryLoadingTile === "true";
          if (selector === "img") return node.tagName === "IMG";
          return false;
        };
        const found: FakeElement[] = [];
        const visit = (node: FakeElement): void => {
          node.children.forEach((child) => {
            if (matches(child)) found.push(child);
            visit(child);
          });
        };
        visit(this);
        return found;
      }
      addEventListener(type: string, listener: (event: Event) => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: string, listener: (event: Event) => void): void { this.listeners.get(type)?.delete(listener); }
      setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
      getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
      hasAttribute(name: string): boolean { return this.attrs.has(name); }
      removeAttribute(name: string): void {
        this.attrs.delete(name);
        if (name === "href") this.href = "";
      }
      append(...nodes: FakeElement[]): void {
        nodes.forEach((node) => {
          node.parentNode = this;
          this.children.push(node);
        });
      }
      appendChild(node: FakeElement): FakeElement {
        if (node.tagName === "#FRAGMENT") {
          node.children.forEach((child) => {
            child.parentNode = this;
            this.children.push(child);
          });
          node.children = [];
        } else {
          this.append(node);
        }
        return node;
      }
      insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
        if (reference === null) return this.appendChild(node);
        const index = this.children.indexOf(reference);
        if (index < 0) throw new Error("Reference node is not a child");
        if (node.tagName === "#FRAGMENT") {
          node.children.forEach((child, offset) => {
            child.parentNode = this;
            this.children.splice(index + offset, 0, child);
          });
          node.children = [];
          return node;
        }
        node.parentNode = this;
        this.children.splice(index, 0, node);
        return node;
      }
      remove(): void {
        if (!this.parentNode) return;
        this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        this.parentNode = null;
      }
      animate(keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
        const record = {
          keyframes,
          options,
          cancelled: false,
          cancel() { this.cancelled = true; },
        };
        this.animations.push(record);
        return record as unknown as Animation;
      }
    }
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeElement });

    try {
      const grid = new FakeElement();
      const initialCard = new FakeElement();
      initialCard.dataset.photoId = "initial";
      initialCard.style.setProperty("--a", "1.5");
      initialCard.outerHTML = '<li data-photo-id="initial" style="--a:1.5"><img></li>';
      grid.children.push(initialCard);
      const link = new FakeElement();
      link.href = "https://example.test/page/2";
      const status = new FakeElement();
      const control = new FakeElement();
      control.outerHTML = '<nav data-gallery-feed-next><a data-gallery-next-link="true" href="/page/2">Next</a></nav>';
      const feed = new FakeElement();
      feed.dataset = {
        galleryScope: "global", galleryPage: "1", galleryTotalPages: "3",
        galleryTotalItems: "50", galleryPageSize: "24", galleryNextUrl: "/page/2",
        galleryNextCount: "24", galleryTerminal: "false",
      };
      feed.queryLists.set('[data-gallery-grid="true"]', [grid]);
      feed.queries.set('[data-gallery-next-link="true"]', link);
      feed.queries.set("[data-gallery-status]", status);
      feed.queries.set("[data-gallery-feed-next]", control);
      feed.append(grid, control, status);

      const documentListeners = new Map<string, Set<(event: Event) => void>>();
      let reduceMotion = false;
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
        createElement: (tagName: string) => {
          const element = new FakeElement();
          element.tagName = tagName.toUpperCase();
          element.ownerDocument = fakeDocument as unknown as { createElement: (tagName: string) => FakeElement };
          return element;
        },
        defaultView: { matchMedia: () => ({ matches: reduceMotion }) },
      };
      feed.ownerDocument = fakeDocument as unknown as { createElement: (tagName: string) => FakeElement };
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
      expect(grid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      expect(feed.attrs.has("data-gallery-auto-load-active")).toBe(false);
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
      expect(grid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      fakeDocument.dispatch({ type: "zfb:before-preparation" } as Event);
      expect(feed.attrs.has("aria-busy")).toBe(false);
      expect(status.textContent).toContain("Loading cancelled");
      expect(link.href).toBe("https://example.test/page/2");
      await expect(loading).resolves.toBe(false);
      expect(grid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      failWithResponse = true;
      const gridBefore = grid.innerHTML;
      await expect(controller!.load("manual")).resolves.toBe(false);
      expect(status.textContent).toContain("Could not load photos");
      expect(grid.innerHTML).toBe(gridBefore);
      expect(grid.children.map((card) => card.dataset.photoId)).toEqual(["initial"]);
      expect(link.href).toBe("https://example.test/page/2");

      const incomingGrid = new FakeElement();
      for (let id = 1; id <= 24; id += 1) {
        const card = new FakeElement();
        const photoId = id === 1 ? "initial" : String(id - 1);
        card.dataset.photoId = photoId;
        card.outerHTML = `<li data-photo-id="${photoId}"><img loading="lazy"></li>`;
        const image = new FakeElement();
        image.loading = "eager";
        card.queryLists.set("img", [image]);
        card.queries.set("img", image);
        incomingGrid.children.push(card);
      }
      const incomingFeed = new FakeElement();
      incomingFeed.dataset = {
        galleryScope: "global", galleryPage: "2", galleryTotalPages: "3",
        galleryTotalItems: "50", galleryPageSize: "24", galleryNextUrl: "/page/3",
        galleryNextCount: "2", galleryTerminal: "false",
      };
      incomingFeed.queryLists.set('[data-gallery-grid="true"]', [incomingGrid]);
      const incomingLink = new FakeElement();
      incomingLink.attrs.set("href", "/page/3");
      incomingFeed.queries.set('[data-gallery-next-link="true"]', incomingLink);
      parsedDocument = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [incomingFeed] : [],
      };
      (fakeDocument as Record<string, unknown>).createDocumentFragment = () => {
        const fragment = new FakeElement();
        fragment.tagName = "#FRAGMENT";
        return fragment;
      };
      (fakeDocument as Record<string, unknown>).importNode = (node: FakeElement) => node;
      failWithResponse = false;
      succeed = true;
      await expect(controller!.load("manual")).resolves.toBe(true);
      expect(grid.children.map((card) => card.dataset.photoId)).toEqual([
        "initial", ...Array.from({ length: 23 }, (_, index) => String(index + 1)),
      ]);
      expect(grid.children.every((card) => card.querySelectorAll("img").every((image) => image.loading === "lazy"))).toBe(true);
      expect(feed.dataset).toMatchObject({
        galleryPage: "2", galleryNextUrl: "/page/3", galleryNextCount: "2", galleryTerminal: "false",
      });
      expect(link.textContent).toBe("Load next 2 photos");
      expect(link.href).toBe("/page/3");
      expect(status.textContent).toBe("Loaded 23 photos.");
      expect(grid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      expect(grid.children.slice(1).every((card) => card.animations.length === 1)).toBe(true);
      expect(grid.children[1]!.animations[0]!.options).toMatchObject({ duration: 280, delay: 0, fill: "backwards" });

      const identity = identityFromState(syncedState, "global", "https://example.test/");
      expect(identity).not.toBeNull();
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.page).toBe(2);
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.cardsHtml).not.toContain("gallery-loading-tile");
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.cardsHtml).not.toContain("animation");

      const terminalGrid = new FakeElement();
      for (let id = 25; id <= 26; id += 1) {
        const card = new FakeElement();
        card.dataset.photoId = String(id);
        card.outerHTML = `<li data-photo-id="${id}"><img loading="lazy"></li>`;
        const image = new FakeElement();
        image.tagName = "IMG";
        card.queryLists.set("img", [image]);
        card.queries.set("img", image);
        terminalGrid.children.push(card);
      }
      const terminalFeed = new FakeElement();
      terminalFeed.dataset = {
        galleryScope: "global", galleryPage: "3", galleryTotalPages: "3",
        galleryTotalItems: "50", galleryPageSize: "24", galleryNextUrl: "",
        galleryNextCount: "0", galleryTerminal: "true",
      };
      terminalFeed.queryLists.set('[data-gallery-grid="true"]', [terminalGrid]);
      parsedDocument = {
        querySelectorAll: (selector: string) => selector === '[data-gallery-feed="true"]' ? [terminalFeed] : [],
      };
      link.href = "https://example.test/page/3";
      reduceMotion = true;
      await expect(controller!.load("manual")).resolves.toBe(true);
      expect(feed.querySelector('[data-gallery-loading-tile="true"]')).toBeNull();
      expect(feed.children.includes(control)).toBe(false);
      expect(status.textContent).toBe("All photos loaded");
      expect(grid.children.slice(24).every((card) => card.animations.length === 0)).toBe(true);

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
      expect(grid.children.slice(1, 24).every((card) => card.animations[0]!.cancelled)).toBe(true);
      expect(store.get(identity!.key, identity!.scope, identity!.url)?.page).toBe(3);

      const makeModeFeed = () => {
        const modeGrid = new FakeElement();
        const modeCard = new FakeElement();
        modeCard.dataset.photoId = "initial";
        modeCard.style.setProperty("--a", "1.5");
        modeCard.outerHTML = '<li data-photo-id="initial"><img></li>';
        modeGrid.append(modeCard);
        const modeLink = new FakeElement();
        modeLink.href = "https://example.test/page/2";
        const modeControl = new FakeElement();
        modeControl.outerHTML = '<nav data-gallery-feed-next><a data-gallery-next-link="true" data-gallery-next-url="/page/2" data-gallery-next-count="24" href="/page/2">Next</a></nav>';
        const modeStatus = new FakeElement();
        const modeFeed = new FakeElement();
        modeFeed.dataset = {
          galleryScope: "global", galleryPage: "1", galleryTotalPages: "3",
          galleryTotalItems: "50", galleryPageSize: "24", galleryNextUrl: "/page/2",
          galleryNextCount: "24", galleryTerminal: "false",
        };
        modeFeed.queryLists.set('[data-gallery-grid="true"]', [modeGrid]);
        modeFeed.queries.set('[data-gallery-next-link="true"]', modeLink);
        modeFeed.queries.set("[data-gallery-feed-next]", modeControl);
        modeFeed.queries.set("[data-gallery-status]", modeStatus);
        modeFeed.append(modeGrid, modeControl, modeStatus);
        modeFeed.ownerDocument = fakeDocument as unknown as { createElement: (tagName: string) => FakeElement };
        activeFeed = modeFeed;
        return { modeFeed, modeGrid, modeLink, modeControl, modeStatus };
      };
      const modeStore = new GallerySnapshotStore(null);
      let modeState: unknown = null;
      const modeEnvironment = (
        createObserver?: (callback: IntersectionObserverCallback, options: IntersectionObserverInit) => Pick<IntersectionObserver, "observe" | "disconnect">,
      ) => ({
        document: fakeDocument as unknown as Document,
        location: { href: "https://example.test/", origin: "https://example.test" } as Location,
        history: { state: modeState } as unknown as History,
        fetch: (async () => new Response("error", { status: 503, headers: { "content-type": "text/html" } })) as typeof fetch,
        parseHtml: () => parsedDocument as Document,
        syncEntry: ((_url: string | URL, options?: { state?: unknown }) => {
          modeState = options?.state ?? null;
        }) as typeof import("@takazudo/zfb-runtime").syncHistoryEntry,
        store: modeStore,
        ...(createObserver ? { createObserver } : {}),
      });

      const baseline = makeModeFeed();
      const baselineController = InfiniteGalleryController.mount(modeEnvironment());
      expect(baselineController?.save()).toBe(true);
      const modeIdentity = identityFromState(modeState, "global", "https://example.test/");
      expect(modeStore.get(modeIdentity!.key, modeIdentity!.scope, modeIdentity!.url)?.nextControlHtml)
        .toBe(baseline.modeControl.outerHTML);
      baselineController?.destroy();

      const absent = makeModeFeed();
      const absentController = InfiniteGalleryController.mount(modeEnvironment());
      expect(absent.modeFeed.attrs.has("data-gallery-auto-load-active")).toBe(false);
      expect(absent.modeGrid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      absentController?.destroy();

      const constructionFailure = makeModeFeed();
      const constructionController = InfiniteGalleryController.mount(modeEnvironment(() => { throw new Error("construction failed"); }));
      expect(constructionFailure.modeFeed.attrs.has("data-gallery-auto-load-active")).toBe(false);
      expect(constructionFailure.modeGrid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      constructionController?.destroy();

      const observationFailure = makeModeFeed();
      const observationController = InfiniteGalleryController.mount(modeEnvironment(() => ({
        observe: () => { throw new Error("observation failed"); },
        disconnect: () => undefined,
      })));
      expect(observationFailure.modeFeed.attrs.has("data-gallery-auto-load-active")).toBe(false);
      expect(observationFailure.modeGrid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      observationController?.destroy();

      const healthy = makeModeFeed();
      let observed: FakeElement | null = null;
      let disconnected = false;
      const healthyController = InfiniteGalleryController.mount(modeEnvironment(() => ({
        observe: (target) => { observed = target as unknown as FakeElement; },
        disconnect: () => { disconnected = true; },
      })));
      const healthyTiles = healthy.modeGrid.querySelectorAll('[data-gallery-loading-tile="true"]');
      expect(healthy.modeFeed.attrs.get("data-gallery-auto-load-active")).toBe("true");
      expect(healthyTiles).toHaveLength(1);
      expect(healthy.modeGrid.children[0]!.dataset.photoId).toBe("initial");
      expect(healthy.modeGrid.children.at(-1)).toBe(healthyTiles[0]);
      expect(healthyTiles[0]!.className).toBe("photo-card gs2");
      expect(healthyTiles[0]!.attrs.get("aria-hidden")).toBe("true");
      expect(observed).toBe(healthyTiles[0]);
      expect(healthyController?.save()).toBe(true);
      const autoHiddenSnapshot = modeStore.get(modeIdentity!.key, modeIdentity!.scope, modeIdentity!.url);
      expect(autoHiddenSnapshot?.nextControlHtml).toBe(healthy.modeControl.outerHTML);
      expect(autoHiddenSnapshot?.nextControlHtml).not.toContain("hidden");
      expect(autoHiddenSnapshot?.nextControlHtml).not.toContain("aria-hidden");
      await expect(healthyController!.load("observer")).resolves.toBe(false);
      expect(healthy.modeFeed.attrs.has("data-gallery-auto-load-active")).toBe(false);
      expect(healthy.modeGrid.querySelectorAll('[data-gallery-loading-tile="true"]')).toHaveLength(0);
      expect(healthy.modeStatus.textContent).toContain("Activate “Load next 24 photos” to retry");
      expect(healthy.modeFeed.children.includes(healthy.modeControl)).toBe(true);
      healthyController!.destroy();
      expect(disconnected).toBe(true);
      expect(healthy.modeFeed.attrs.has("data-gallery-auto-load-active")).toBe(false);
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
    expect(isGallerySnapshot(snapshot("gallery-12345678", { version: 1 as 2 }))).toBe(false);
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

  it("rejects legacy disabled controls from terminal snapshots before injection", () => {
    const terminal = snapshot("gallery-12345678", {
      page: 3,
      nextUrl: "",
      nextCount: 0,
      terminal: true,
      nextControlHtml: '<nav data-gallery-feed-next><a data-gallery-next-link="true" aria-disabled="true">All photos loaded</a></nav>',
    });
    expect(isGallerySnapshot(terminal)).toBe(false);
    expect(injectGallerySnapshot({} as ParentNode, terminal)).toBe(false);
    expect(isGallerySnapshot({ ...terminal, nextControlHtml: "" })).toBe(true);
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
