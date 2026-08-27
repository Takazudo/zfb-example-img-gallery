import {
  isTransitionBeforePreparationEvent,
  isTransitionBeforeSwapEvent,
  syncHistoryEntry,
} from "@takazudo/zfb-runtime";
import {
  GALLERY_HISTORY_STATE_KEY,
  GALLERY_SNAPSHOT_VERSION,
  GallerySnapshotStore,
  isGalleryEntryIdentity,
  type GalleryEntryIdentity,
  type GallerySnapshot,
} from "./gallery-snapshots";
import {
  loadingFieldTiles,
  medianAspectRatio,
  revealSchedule,
} from "./gallery-loading-field";

const FEED_SELECTOR = '[data-gallery-feed="true"]';
const GRID_SELECTOR = '[data-gallery-grid="true"]';
const LINK_SELECTOR = '[data-gallery-next-link="true"]';
const CONTROL_SELECTOR = "[data-gallery-feed-next]";
const STATUS_SELECTOR = "[data-gallery-status]";
const LOADING_TILE_SELECTOR = '[data-gallery-loading-tile="true"]';
const AUTO_LOAD_SENTINEL_SELECTOR = '[data-gallery-auto-load-sentinel="true"]';
const AUTO_LOAD_ACTIVE_ATTRIBUTE = "data-gallery-auto-load-active";
const AUTO_LOAD_ROOT_MARGIN_PX = 240;
export const MAX_BATCH_SIZE = 24;

export type FeedMetadata = {
  scope: string;
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  nextUrl: string;
  nextCount: number;
  terminal: boolean;
};

export type FeedDataset = Partial<Record<
  "galleryScope" | "galleryPage" | "galleryTotalPages" | "galleryTotalItems"
  | "galleryPageSize" | "galleryNextUrl" | "galleryNextCount" | "galleryTerminal",
  string
>>;

function parseInteger(value: string | undefined, positive: boolean): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (positive ? parsed < 1 : parsed < 0)) return null;
  return parsed;
}

export function parseFeedMetadata(dataset: FeedDataset): FeedMetadata | null {
  const page = parseInteger(dataset.galleryPage, true);
  const totalPages = parseInteger(dataset.galleryTotalPages, true);
  const totalItems = parseInteger(dataset.galleryTotalItems, false);
  const pageSize = parseInteger(dataset.galleryPageSize, true);
  const nextCount = parseInteger(dataset.galleryNextCount, false);
  const terminal = dataset.galleryTerminal === "true"
    ? true
    : dataset.galleryTerminal === "false" ? false : null;
  const scope = dataset.galleryScope;
  const nextUrl = dataset.galleryNextUrl;
  if (
    !scope || page === null || totalPages === null || totalItems === null
    || pageSize === null || nextCount === null || terminal === null || nextUrl === undefined
    || page > totalPages || pageSize > MAX_BATCH_SIZE || nextCount > pageSize
    || terminal !== (nextUrl === "")
    || (terminal ? nextCount !== 0 : nextCount === 0)
  ) return null;
  return { scope, page, totalPages, totalItems, pageSize, nextUrl, nextCount, terminal };
}

export function isSequentialFeed(current: FeedMetadata, incoming: FeedMetadata): boolean {
  return incoming.scope === current.scope
    && incoming.page === current.page + 1
    && incoming.pageSize === current.pageSize
    && incoming.totalPages === current.totalPages
    && incoming.totalItems === current.totalItems
    && incoming.page <= incoming.totalPages;
}

export function isHtmlContentType(value: string | null): boolean {
  const mediaType = (value ?? "").split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

export function unseenPhotoIds(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set(existing);
  const result: string[] = [];
  for (const id of incoming) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Pure observer state: an automatic success disarms until the user continues
 * downward or the observer receives a non-intersecting sample. */
export class GalleryAutoLoadGate {
  #armed = true;

  get armed(): boolean {
    return this.#armed;
  }

  observe(isIntersecting: boolean): boolean {
    if (!isIntersecting) {
      this.#armed = true;
      return false;
    }
    return this.#armed;
  }

  automaticSuccess(): void {
    this.#armed = false;
  }

  continueAfterInput(): void {
    this.#armed = true;
  }
}

export class GallerySingleFlight {
  #pending: Promise<boolean> | null = null;

  get pending(): Promise<boolean> | null {
    return this.#pending;
  }

  run(task: () => Promise<boolean>): Promise<boolean> {
    if (this.#pending) return this.#pending;
    const pending = task().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export const gallerySnapshotStore = new GallerySnapshotStore(browserStorage());

let fallbackKeySequence = 0;
export function createGalleryEntryKey(): string {
  try {
    if (typeof crypto.randomUUID === "function") return `gallery-${crypto.randomUUID()}`;
    const random = new Uint32Array(4);
    crypto.getRandomValues(random);
    return `gallery-${[...random].map((part) => part.toString(16).padStart(8, "0")).join("")}`;
  } catch {
    fallbackKeySequence += 1;
    return `gallery-${Date.now().toString(36)}-${fallbackKeySequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function identityFromState(state: unknown, scope?: string, url?: string): GalleryEntryIdentity | null {
  if (!state || typeof state !== "object") return null;
  const identity = (state as Record<string, unknown>)[GALLERY_HISTORY_STATE_KEY];
  return isGalleryEntryIdentity(identity, scope, url) ? identity : null;
}

export function stateWithGalleryIdentity(state: unknown, identity: GalleryEntryIdentity): Record<string, unknown> {
  const current = state && typeof state === "object" ? state as Record<string, unknown> : {};
  return { ...current, [GALLERY_HISTORY_STATE_KEY]: identity };
}

function feedMetadata(feed: Element): FeedMetadata | null {
  return parseFeedMetadata((feed as HTMLElement).dataset as FeedDataset);
}

function singleFeed(root: ParentNode): HTMLElement | null {
  const feeds = root.querySelectorAll(FEED_SELECTOR);
  if (feeds.length !== 1) return null;
  return feeds[0] as HTMLElement;
}

function feedElements(root: ParentNode): { feed: HTMLElement; grid: HTMLElement } | null {
  const feed = singleFeed(root);
  if (!feed) return null;
  const grids = feed.querySelectorAll(GRID_SELECTOR);
  if (grids.length !== 1) return null;
  return { feed, grid: grids[0] as HTMLElement };
}

function photoCards(grid: Element): HTMLElement[] {
  return [...grid.children].filter((node): node is HTMLElement => (
    node instanceof HTMLElement && node.dataset.photoId !== undefined
  ));
}

function setFeedMetadata(feed: HTMLElement, metadata: FeedMetadata): void {
  feed.dataset.galleryScope = metadata.scope;
  feed.dataset.galleryPage = String(metadata.page);
  feed.dataset.galleryTotalPages = String(metadata.totalPages);
  feed.dataset.galleryTotalItems = String(metadata.totalItems);
  feed.dataset.galleryPageSize = String(metadata.pageSize);
  feed.dataset.galleryNextUrl = metadata.nextUrl;
  feed.dataset.galleryNextCount = String(metadata.nextCount);
  feed.dataset.galleryTerminal = String(metadata.terminal);
}

function updateLink(link: HTMLAnchorElement, metadata: FeedMetadata): void {
  link.dataset.galleryNextUrl = metadata.nextUrl;
  link.dataset.galleryNextCount = String(metadata.nextCount);
  link.removeAttribute("aria-disabled");
  link.href = metadata.nextUrl;
  link.textContent = `Load next ${metadata.nextCount} photos`;
}

function hasUnsafeSnapshotMarkup(element: Element, entryUrl: string): boolean {
  const nodes = [element, ...element.querySelectorAll("*")];
  for (const node of nodes) {
    if (["SCRIPT", "IFRAME", "OBJECT", "EMBED"].includes(node.tagName)) return true;
    for (const attribute of node.attributes) {
      if (attribute.name.toLowerCase().startsWith("on")) return true;
      if (["href", "src", "action", "formaction", "xlink:href"].includes(attribute.name.toLowerCase())) {
        try {
          if (new URL(attribute.value, entryUrl).origin !== new URL(entryUrl).origin) return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}

export function captureGallerySnapshot(
  root: ParentNode,
  identity: GalleryEntryIdentity,
  now = Date.now(),
): GallerySnapshot | null {
  const elements = feedElements(root);
  if (!elements) return null;
  const metadata = feedMetadata(elements.feed);
  if (!metadata || metadata.scope !== identity.scope) return null;
  const cards = photoCards(elements.grid);
  const photoIds = cards.map((card) => card.dataset.photoId ?? "");
  if (photoIds.some((id) => id === "") || new Set(photoIds).size !== photoIds.length) return null;
  const control = elements.feed.querySelector<HTMLElement>(CONTROL_SELECTOR);
  return {
    version: GALLERY_SNAPSHOT_VERSION,
    key: identity.key,
    entryUrl: identity.url,
    ...metadata,
    photoIds,
    cardsHtml: cards.map((card) => card.outerHTML).join(""),
    // Automatic visibility is feed state, never canonical control markup.
    nextControlHtml: metadata.terminal ? "" : control?.outerHTML ?? "",
    savedAt: now,
  };
}

/** Patch a detached incoming document (or a reload DOM) only after full validation. */
export function injectGallerySnapshot(root: ParentNode, snapshot: GallerySnapshot): boolean {
  const elements = feedElements(root);
  if (!elements) return false;
  const incoming = feedMetadata(elements.feed);
  if (!incoming || incoming.scope !== snapshot.scope) return false;

  const currentIds = photoCards(elements.grid).map((card) => card.dataset.photoId ?? "");
  const alreadyRestored = currentIds.length === snapshot.photoIds.length
    && currentIds.every((id, index) => id === snapshot.photoIds[index])
    && incoming.page === snapshot.page
    && incoming.totalPages === snapshot.totalPages
    && incoming.totalItems === snapshot.totalItems
    && incoming.pageSize === snapshot.pageSize
    && incoming.nextUrl === snapshot.nextUrl
    && incoming.nextCount === snapshot.nextCount
    && incoming.terminal === snapshot.terminal;
  // A bfcache restore retains the controller, its bound anchor, and the live
  // expanded DOM. Do not replace those nodes when the snapshot is already live.
  if (alreadyRestored) {
    elements.feed.removeAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE);
    elements.grid.querySelectorAll(LOADING_TILE_SELECTOR).forEach((tile) => tile.remove());
    elements.feed.querySelectorAll(AUTO_LOAD_SENTINEL_SELECTOR).forEach((sentinel) => sentinel.remove());
    return true;
  }

  const template = elements.feed.ownerDocument.createElement("template");
  template.innerHTML = snapshot.cardsHtml;
  const stagedCards = [...template.content.children].filter((node): node is HTMLElement => node instanceof HTMLElement);
  const stagedIds = stagedCards.map((card) => card.dataset.photoId ?? "");
  if (
    stagedCards.length !== template.content.children.length
    || stagedIds.length !== snapshot.photoIds.length
    || stagedIds.some((id, index) => id !== snapshot.photoIds[index])
    || stagedCards.some((card) => card.querySelector("img") === null)
    || stagedCards.some((card) => hasUnsafeSnapshotMarkup(card, snapshot.entryUrl))
  ) return false;
  stagedCards.forEach((card) => card.querySelectorAll("img").forEach((image) => image.loading = "lazy"));

  const controlTemplate = elements.feed.ownerDocument.createElement("template");
  controlTemplate.innerHTML = snapshot.nextControlHtml;
  const stagedControl = controlTemplate.content.firstElementChild;
  if (snapshot.nextControlHtml && (!(stagedControl instanceof HTMLElement) || !stagedControl.matches(CONTROL_SELECTOR))) {
    return false;
  }
  if (stagedControl) {
    const links = stagedControl.querySelectorAll<HTMLAnchorElement>(LINK_SELECTOR);
    if (links.length !== 1 || hasUnsafeSnapshotMarkup(stagedControl, snapshot.entryUrl)) return false;
    const stagedLink = links[0]!;
    if (
      stagedLink.dataset.galleryNextUrl !== snapshot.nextUrl
      || stagedLink.dataset.galleryNextCount !== String(snapshot.nextCount)
      || (snapshot.terminal
        ? stagedLink.hasAttribute("href") || stagedLink.getAttribute("aria-disabled") !== "true"
        : !stagedLink.getAttribute("href")
          || new URL(stagedLink.getAttribute("href")!, snapshot.entryUrl).href !== new URL(snapshot.nextUrl, snapshot.entryUrl).href)
    ) return false;
  }

  elements.feed.removeAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE);
  elements.grid.querySelectorAll(LOADING_TILE_SELECTOR).forEach((tile) => tile.remove());
  elements.feed.querySelectorAll(AUTO_LOAD_SENTINEL_SELECTOR).forEach((sentinel) => sentinel.remove());
  elements.grid.replaceChildren(template.content);
  setFeedMetadata(elements.feed, snapshot);
  const currentControl = elements.feed.querySelector(CONTROL_SELECTOR);
  if (stagedControl) {
    currentControl?.replaceWith(stagedControl);
    if (!currentControl) {
      const status = elements.feed.querySelector(STATUS_SELECTOR);
      if (status?.parentNode) status.parentNode.insertBefore(stagedControl, status);
    }
  } else {
    currentControl?.remove();
  }
  const status = elements.feed.querySelector<HTMLElement>(STATUS_SELECTOR);
  if (status) {
    status.textContent = snapshot.terminal ? "All photos loaded" : "";
    status.hidden = !snapshot.terminal;
  }
  return true;
}

type IntersectionObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => Pick<IntersectionObserver, "observe" | "disconnect">;

export type InfiniteGalleryEnvironment = {
  document: Document;
  location: Location;
  history: History;
  fetch: typeof fetch;
  createObserver?: IntersectionObserverFactory;
  parseHtml: (html: string, type: DOMParserSupportedType) => Document;
  syncEntry: typeof syncHistoryEntry;
  store: GallerySnapshotStore;
};

export type GalleryRefreshEnvironment = Pick<
  InfiniteGalleryEnvironment,
  "document" | "location" | "fetch" | "parseHtml"
>;

/** Replace the active feed from its canonical server response after an
 * offset-sensitive collection mutation (notably an unfavorite). */
export async function refreshActiveGalleryFeed(
  environment?: GalleryRefreshEnvironment,
): Promise<boolean> {
  const env = environment ?? defaultEnvironment();
  if (!env) return false;
  const currentFeed = singleFeed(env.document);
  if (!currentFeed) return false;
  const current = feedMetadata(currentFeed);
  if (!current) return false;
  try {
    const response = await env.fetch(env.location.href, {
      headers: { Accept: "text/html, application/xhtml+xml" },
    });
    if (!response.ok || !isHtmlContentType(response.headers.get("content-type"))) return false;
    if (response.redirected && response.url && response.url !== env.location.href) return false;
    const mediaType = (response.headers.get("content-type") ?? "text/html").split(";", 1)[0]!.trim() as DOMParserSupportedType;
    const incomingDocument = env.parseHtml(await response.text(), mediaType);
    const incomingFeed = singleFeed(incomingDocument);
    const incoming = incomingFeed ? feedMetadata(incomingFeed) : null;
    if (!incomingFeed || !incoming || incoming.scope !== current.scope) return false;
    const imported = env.document.importNode(incomingFeed, true) as HTMLElement;
    currentFeed.replaceWith(imported);
    return true;
  } catch {
    return false;
  }
}

function defaultEnvironment(): InfiniteGalleryEnvironment | null {
  if (typeof document === "undefined" || typeof location === "undefined" || typeof history === "undefined") return null;
  const createObserver = typeof IntersectionObserver === "undefined"
    ? undefined
    : ((callback: IntersectionObserverCallback, options: IntersectionObserverInit) => new IntersectionObserver(callback, options));
  return {
    document,
    location,
    history,
    fetch: globalThis.fetch.bind(globalThis),
    ...(createObserver ? { createObserver } : {}),
    parseHtml: (html, type) => new DOMParser().parseFromString(html, type),
    syncEntry: syncHistoryEntry,
    store: gallerySnapshotStore,
  };
}

export class InfiniteGalleryController {
  readonly #env: InfiniteGalleryEnvironment;
  readonly #feed: HTMLElement;
  readonly #grid: HTMLElement;
  readonly #status: HTMLElement | null;
  #link: HTMLAnchorElement | null;
  #identity: GalleryEntryIdentity;
  #observer: Pick<IntersectionObserver, "observe" | "disconnect"> | null = null;
  readonly #autoGate = new GalleryAutoLoadGate();
  readonly #flight = new GallerySingleFlight();
  #abortController: AbortController | null = null;
  #autoLoadSentinel: HTMLElement | null = null;
  #queuedAutoContinuation = false;
  readonly #revealAnimations = new Set<Animation>();
  #generation = 0;
  #destroyed = false;

  static mount(environment = defaultEnvironment()): InfiniteGalleryController | null {
    if (!environment) return null;
    const elements = feedElements(environment.document);
    if (!elements) return null;
    const metadata = feedMetadata(elements.feed);
    if (!metadata) return null;

    const existing = identityFromState(environment.history.state, metadata.scope, environment.location.href);
    const identity = existing ?? {
      version: GALLERY_SNAPSHOT_VERSION,
      key: createGalleryEntryKey(),
      scope: metadata.scope,
      url: environment.location.href,
    };
    if (!existing) {
      try {
        environment.syncEntry(environment.location.href, {
          replace: true,
          state: stateWithGalleryIdentity(environment.history.state, identity),
        });
      } catch {
        // The feed still works if history is unavailable or rejects a write.
      }
    }

    const snapshot = environment.store.get(identity.key, identity.scope, identity.url);
    if (snapshot) injectGallerySnapshot(environment.document, snapshot);
    const restoredElements = feedElements(environment.document);
    if (!restoredElements) return null;
    return new InfiniteGalleryController(environment, restoredElements.feed, restoredElements.grid, identity);
  }

  private constructor(
    environment: InfiniteGalleryEnvironment,
    feed: HTMLElement,
    grid: HTMLElement,
    identity: GalleryEntryIdentity,
  ) {
    this.#env = environment;
    this.#feed = feed;
    this.#grid = grid;
    this.#identity = identity;
    this.#status = feed.querySelector<HTMLElement>(STATUS_SELECTOR);
    this.#link = feed.querySelector<HTMLAnchorElement>(LINK_SELECTOR);
    this.#link?.addEventListener("click", this.#onClick);
    environment.document.addEventListener("zfb:before-preparation", this.#onBeforePreparation);
    this.#initializeAutomaticMode(feedMetadata(feed));
  }

  load(source: "manual" | "observer"): Promise<boolean> {
    if (this.#flight.pending) return this.#flight.pending;
    if (source === "observer" && !this.#autoGate.armed) return Promise.resolve(false);
    const request = this.#nextRequest();
    if (!request) return Promise.resolve(false);
    const { link, metadata, requestedUrl } = request;
    const generation = ++this.#generation;
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#buildLoadingTail(metadata);
    this.#setStatus(`Loading ${metadata.nextCount} photos…`, true);

    const pending = this.#flight.run(() => this.#performLoad(requestedUrl, metadata, abortController.signal, generation)
      .then((success) => {
        if (success && source === "observer") this.#autoGate.automaticSuccess();
        return success;
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted && generation === this.#generation && !this.#destroyed) {
          this.#disableAutomaticMode();
          this.#setStatus(`Could not load photos. Activate “Load next ${metadata.nextCount} photos” to retry.`, false);
        }
        return false;
      })
      .finally(() => {
        if (this.#abortController === abortController) this.#abortController = null;
        if (generation === this.#generation) this.#feed.removeAttribute("aria-busy");
      }));
    void pending.then((success) => this.#continueAutomaticLoad(success));
    return pending;
  }

  save(): boolean {
    const snapshot = captureGallerySnapshot(this.#env.document, this.#identity);
    return snapshot ? this.#env.store.set(snapshot) : false;
  }

  restore(): boolean {
    const snapshot = this.#env.store.get(this.#identity.key, this.#identity.scope, this.#identity.url);
    if (!snapshot) return false;
    this.#cancelRevealAnimations();
    this.#disableAutomaticMode();
    this.#observer?.disconnect();
    this.#observer = null;
    const restored = injectGallerySnapshot(this.#env.document, snapshot);
    if (restored) {
      this.#link?.removeEventListener("click", this.#onClick);
      this.#link = this.#feed.querySelector<HTMLAnchorElement>(LINK_SELECTOR);
      this.#link?.addEventListener("click", this.#onClick);
      this.#initializeAutomaticMode(feedMetadata(this.#feed));
    }
    return restored;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // zfb unmounts the outgoing island after swapping the body. Saving through
    // the global Document here could therefore capture a same-scope destination
    // feed under this outgoing entry's identity. Successful appends and the
    // earlier before-preparation hook already persist every useful snapshot.
    this.#generation += 1;
    this.#abortController?.abort();
    this.#cancelRevealAnimations();
    this.#disableAutomaticMode();
    this.#observer?.disconnect();
    this.#link?.removeEventListener("click", this.#onClick);
    this.#env.document.removeEventListener("wheel", this.#onWheel);
    this.#env.document.removeEventListener("zfb:before-preparation", this.#onBeforePreparation);
  }

  readonly #onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // Malformed hooks must preserve the native anchor fallback.
    if (!this.#nextRequest()) return;
    event.preventDefault();
    void this.load("manual");
  };

  readonly #onIntersection: IntersectionObserverCallback = (entries): void => {
    const entry = entries.find((candidate) => candidate.target === this.#autoLoadSentinel);
    if (!entry) return;
    if (!entry.isIntersecting) this.#queuedAutoContinuation = false;
    if (this.#autoGate.observe(entry.isIntersecting)) void this.load("observer");
  };

  readonly #onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || event.ctrlKey) return;
    if (event.deltaY < 0) {
      this.#queuedAutoContinuation = false;
      return;
    }
    if (event.deltaY === 0 || !this.#autoLoadSentinelIsInRange()) return;
    if (this.#flight.pending) {
      this.#queuedAutoContinuation = true;
      return;
    }
    this.#autoGate.continueAfterInput();
    void this.load("observer");
  };

  readonly #onBeforePreparation = (event: Event): void => {
    if (!isTransitionBeforePreparationEvent(event)) return;
    this.#cancelRevealAnimations();
    // This identity was captured at mount; history.state may already become the
    // destination entry before old-island cleanup on a traversal.
    this.save();
    this.#generation += 1;
    this.#abortController?.abort();
    const metadata = feedMetadata(this.#feed);
    if (metadata && this.#abortController) {
      this.#disableAutomaticMode();
      this.#setStatus(`Loading cancelled. Activate “Load next ${metadata.nextCount} photos” to retry.`, false);
    }
  };

  async #performLoad(
    requestedUrl: string,
    current: FeedMetadata,
    signal: AbortSignal,
    generation: number,
  ): Promise<boolean> {
    const response = await this.#env.fetch(requestedUrl, {
      signal,
      headers: { Accept: "text/html, application/xhtml+xml" },
    });
    if (!response.ok || !isHtmlContentType(response.headers.get("content-type"))) throw new Error("Invalid gallery response");
    if (response.redirected && response.url && response.url !== requestedUrl) throw new Error("Unexpected gallery redirect");
    const mediaType = (response.headers.get("content-type") ?? "text/html").split(";", 1)[0]!.trim() as DOMParserSupportedType;
    const incomingDocument = this.#env.parseHtml(await response.text(), mediaType);
    const incomingElements = feedElements(incomingDocument);
    if (!incomingElements) throw new Error("Missing gallery fragment");
    const incoming = feedMetadata(incomingElements.feed);
    if (!incoming || !isSequentialFeed(current, incoming)) throw new Error("Unexpected gallery cursor");
    const incomingCards = photoCards(incomingElements.grid);
    if (
      incomingCards.length !== incomingElements.grid.children.length
      || incomingCards.length !== current.nextCount
      || incomingCards.length > MAX_BATCH_SIZE
      || incomingCards.some((card) => card.querySelector("img") === null)
    ) throw new Error("Unexpected gallery batch size");
    const incomingIds = incomingCards.map((card) => card.dataset.photoId ?? "");
    if (incomingIds.some((id) => id === "") || new Set(incomingIds).size !== incomingIds.length) throw new Error("Invalid gallery cards");
    if (!incoming.terminal) {
      const incomingLink = incomingElements.feed.querySelector<HTMLAnchorElement>(LINK_SELECTOR);
      const nextUrl = new URL(incoming.nextUrl, requestedUrl);
      const linkHref = incomingLink?.getAttribute("href");
      if (
        !incomingLink || !linkHref
        || nextUrl.origin !== this.#env.location.origin
        || new URL(linkHref, requestedUrl).href !== nextUrl.href
      ) {
        throw new Error("Invalid gallery continuation");
      }
    }

    const existingIds = photoCards(this.#grid).map((card) => card.dataset.photoId ?? "");
    const appendIds = new Set(unseenPhotoIds(existingIds, incomingIds));
    const fragment = this.#env.document.createDocumentFragment();
    const appendedCards: HTMLElement[] = [];
    for (const card of incomingCards) {
      const id = card.dataset.photoId ?? "";
      if (!appendIds.has(id)) continue;
      const clone = this.#env.document.importNode(card, true) as HTMLElement;
      clone.querySelectorAll("img").forEach((image) => image.loading = "lazy");
      fragment.append(clone);
      appendedCards.push(clone);
      appendIds.delete(id);
    }

    if (signal.aborted || generation !== this.#generation || this.#destroyed) return false;
    const liveLink = this.#link;
    if (!liveLink) return false;
    const tailBoundary = this.#grid.querySelector<HTMLElement>(LOADING_TILE_SELECTOR);
    this.#grid.insertBefore(fragment, tailBoundary);
    this.#removeLoadingTail();
    this.#reveal(appendedCards);
    setFeedMetadata(this.#feed, incoming);
    if (incoming.terminal) {
      liveLink.removeEventListener("click", this.#onClick);
      this.#feed.querySelector(CONTROL_SELECTOR)?.remove();
      this.#link = null;
      this.#disableAutomaticMode();
    } else {
      updateLink(liveLink, incoming);
      if (this.#observer) {
        // Keep the successfully observed target stable across appends. In
        // particular, do not clear a wheel-queued continuation while replacing
        // the consumed grid tail.
        if (this.#feed.hasAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE) && this.#autoLoadSentinel?.isConnected) {
          this.#buildLoadingTail(incoming);
        } else {
          this.#enableAutomaticMode(incoming);
        }
      }
    }
    this.#setStatus(incoming.terminal ? "All photos loaded" : `Loaded ${appendedCards.length} photos.`, false);
    this.save();
    return true;
  }

  #setStatus(message: string, busy: boolean): void {
    if (busy) this.#feed.setAttribute("aria-busy", "true");
    else this.#feed.removeAttribute("aria-busy");
    if (this.#status) {
      this.#status.textContent = message;
      this.#status.hidden = message === "";
    }
  }

  #buildLoadingTail(metadata: FeedMetadata | null): void {
    this.#removeLoadingTail();
    if (!metadata || metadata.terminal) return;

    const ratios = photoCards(this.#grid).map((card) => Number.parseFloat(
      card.style.getPropertyValue("--a"),
    ));
    const tiles = loadingFieldTiles(metadata, medianAspectRatio(ratios));
    if (tiles.length === 0) return;

    for (const tile of tiles) {
      const card = this.#env.document.createElement("li");
      card.className = `photo-card ${tile.className}`;
      card.dataset.galleryLoadingTile = "true";
      card.setAttribute("aria-hidden", "true");
      card.style.setProperty("--a", String(tile.aspectRatio));
      const mediaWrapper = this.#env.document.createElement("div");
      mediaWrapper.className = "photo-card-media-wrapper";
      const link = this.#env.document.createElement("div");
      link.className = "photo-card-link";
      const media = this.#env.document.createElement("div");
      media.className = "photo-card-media";
      const fill = this.#env.document.createElement("div");
      fill.className = "photo-card-image photo-card-skeleton-fill";
      media.appendChild(fill);
      link.appendChild(media);
      mediaWrapper.appendChild(link);
      const title = this.#env.document.createElement("div");
      title.className = "photo-card-title";
      title.textContent = "\u00a0";
      card.appendChild(mediaWrapper);
      card.appendChild(title);
      this.#grid.appendChild(card);
    }
  }

  #removeLoadingTail(): void {
    this.#grid.querySelectorAll(LOADING_TILE_SELECTOR).forEach((tile) => tile.remove());
  }

  #createAutoLoadSentinel(): HTMLElement {
    const sentinel = this.#env.document.createElement("div");
    sentinel.dataset.galleryAutoLoadSentinel = "true";
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.setProperty("block-size", "1px");
    const parent = this.#grid.parentNode;
    if (!parent) throw new Error("Gallery grid is detached");
    const siblings = [...parent.children];
    parent.insertBefore(sentinel, siblings[siblings.indexOf(this.#grid) + 1] ?? null);
    this.#autoLoadSentinel = sentinel;
    return sentinel;
  }

  #initializeAutomaticMode(metadata: FeedMetadata | null): void {
    if (!metadata || metadata.terminal || !this.#link || !this.#env.createObserver) return;
    try {
      this.#observer = this.#env.createObserver(this.#onIntersection, {
        rootMargin: `0px 0px ${AUTO_LOAD_ROOT_MARGIN_PX}px`,
      });
      this.#enableAutomaticMode(metadata);
      if (this.#feed.hasAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE)) {
        this.#env.document.addEventListener("wheel", this.#onWheel, { passive: true });
      }
    } catch {
      this.#observer = null;
      this.#disableAutomaticMode();
    }
  }

  #enableAutomaticMode(metadata: FeedMetadata): void {
    if (!this.#observer || metadata.terminal || !this.#link) return;
    this.#removeAutoLoadSentinel();
    const sentinel = this.#createAutoLoadSentinel();
    try {
      this.#observer.observe(sentinel);
    } catch {
      sentinel.remove();
      this.#autoLoadSentinel = null;
      this.#observer = null;
      this.#disableAutomaticMode();
      return;
    }
    this.#feed.setAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE, "true");
    this.#buildLoadingTail(metadata);
  }

  #disableAutomaticMode(): void {
    this.#feed.removeAttribute(AUTO_LOAD_ACTIVE_ATTRIBUTE);
    this.#removeLoadingTail();
    this.#removeAutoLoadSentinel();
  }

  #removeAutoLoadSentinel(): void {
    this.#observer?.disconnect();
    this.#queuedAutoContinuation = false;
    this.#autoLoadSentinel?.remove();
    this.#autoLoadSentinel = null;
    this.#feed.querySelectorAll(AUTO_LOAD_SENTINEL_SELECTOR).forEach((sentinel) => sentinel.remove());
  }

  #autoLoadSentinelIsInRange(): boolean {
    const view = this.#env.document.defaultView;
    const sentinel = this.#autoLoadSentinel;
    if (!view || !sentinel?.isConnected) return false;
    const rect = sentinel.getBoundingClientRect();
    return rect.bottom >= 0
      && rect.top <= view.innerHeight + AUTO_LOAD_ROOT_MARGIN_PX
      && rect.right >= 0
      && rect.left <= view.innerWidth;
  }

  #continueAutomaticLoad(success: boolean): void {
    if (!this.#queuedAutoContinuation) return;
    this.#queuedAutoContinuation = false;
    if (!success || this.#destroyed || !this.#autoLoadSentinelIsInRange()) return;
    this.#autoGate.continueAfterInput();
    void this.load("observer");
  }

  #reveal(cards: readonly HTMLElement[]): void {
    let reduceMotion = false;
    try {
      reduceMotion = this.#env.document.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
    } catch {
      // A missing or restricted media-query API should not suppress enhancement.
    }
    if (reduceMotion) return;

    const delays = revealSchedule(cards.length);
    cards.forEach((card, index) => {
      if (typeof card.animate !== "function") return;
      const animation = card.animate([
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], {
        duration: 280,
        delay: delays[index] ?? 0,
        easing: "ease-out",
        fill: "backwards",
      });
      this.#revealAnimations.add(animation);
    });
  }

  #cancelRevealAnimations(): void {
    this.#revealAnimations.forEach((animation) => animation.cancel());
    this.#revealAnimations.clear();
  }

  #nextRequest(): { link: HTMLAnchorElement; metadata: FeedMetadata; requestedUrl: string } | null {
    const metadata = feedMetadata(this.#feed);
    const link = this.#link;
    if (!metadata || metadata.terminal || !link) return null;
    try {
      const requestedUrl = new URL(metadata.nextUrl, this.#env.location.href).href;
      if (new URL(requestedUrl).origin !== this.#env.location.origin || link.href !== requestedUrl) return null;
      return { link, metadata, requestedUrl };
    } catch {
      return null;
    }
  }
}

let moduleListenersRegistered = false;

export function registerGalleryHistoryListeners(target: Document = document): void {
  if (moduleListenersRegistered) return;
  moduleListenersRegistered = true;
  target.addEventListener("zfb:before-swap", (event) => {
    if (!isTransitionBeforeSwapEvent(event) || event.navigationType !== "traverse") return;
    const incomingElements = feedElements(event.newDocument);
    if (!incomingElements) return;
    const metadata = feedMetadata(incomingElements.feed);
    if (!metadata) return;
    const identity = identityFromState(history.state, metadata.scope, event.to.href);
    if (!identity) return;
    const snapshot = gallerySnapshotStore.get(identity.key, identity.scope, identity.url);
    if (snapshot) injectGallerySnapshot(event.newDocument, snapshot);
  });
}

if (typeof document !== "undefined") registerGalleryHistoryListeners(document);
