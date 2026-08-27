export const GALLERY_SNAPSHOT_VERSION = 2 as const;
export const GALLERY_HISTORY_STATE_KEY = "zfbGallerySnapshot";
export const GALLERY_SNAPSHOT_STORAGE_PREFIX = "zfb-gallery-snapshot:";
export const GALLERY_SNAPSHOT_INDEX_KEY = `${GALLERY_SNAPSHOT_STORAGE_PREFIX}index`;
const MAX_INDEX_BYTES = 64 * 1024;

export const DEFAULT_SNAPSHOT_LIMITS = {
  maxEntries: 5,
  maxEntryBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

export type GalleryEntryIdentity = {
  version: typeof GALLERY_SNAPSHOT_VERSION;
  key: string;
  scope: string;
  url: string;
};

export type GallerySnapshot = {
  version: typeof GALLERY_SNAPSHOT_VERSION;
  key: string;
  scope: string;
  entryUrl: string;
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  nextUrl: string;
  nextCount: number;
  terminal: boolean;
  photoIds: string[];
  cardsHtml: string;
  nextControlHtml: string;
  savedAt: number;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type SnapshotLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
};

type StoredIndexItem = { key: string; bytes: number };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isGalleryEntryIdentity(
  value: unknown,
  scope?: string,
  url?: string,
): value is GalleryEntryIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return identity.version === GALLERY_SNAPSHOT_VERSION
    && typeof identity.key === "string"
    && identity.key.length >= 8
    && identity.key.length <= 160
    && typeof identity.scope === "string"
    && identity.scope.length > 0
    && typeof identity.url === "string"
    && identity.url.length > 0
    && (scope === undefined || identity.scope === scope)
    && (url === undefined || identity.url === url);
}

export function isGallerySnapshot(
  value: unknown,
  expected: { key?: string; scope?: string; entryUrl?: string } = {},
): value is GallerySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== GALLERY_SNAPSHOT_VERSION
    || typeof snapshot.key !== "string"
    || snapshot.key.length < 8
    || snapshot.key.length > 160
    || typeof snapshot.scope !== "string"
    || snapshot.scope.length === 0
    || typeof snapshot.entryUrl !== "string"
    || snapshot.entryUrl.length === 0
    || (expected.key !== undefined && snapshot.key !== expected.key)
    || (expected.scope !== undefined && snapshot.scope !== expected.scope)
    || (expected.entryUrl !== undefined && snapshot.entryUrl !== expected.entryUrl)
    || !isPositiveInteger(snapshot.page)
    || !isPositiveInteger(snapshot.totalPages)
    || !isNonNegativeInteger(snapshot.totalItems)
    || !isPositiveInteger(snapshot.pageSize)
    || !isNonNegativeInteger(snapshot.nextCount)
    || typeof snapshot.nextUrl !== "string"
    || typeof snapshot.terminal !== "boolean"
    || !Array.isArray(snapshot.photoIds)
    || !snapshot.photoIds.every((id) => typeof id === "string" && id.length > 0)
    || new Set(snapshot.photoIds as string[]).size !== snapshot.photoIds.length
    || typeof snapshot.cardsHtml !== "string"
    || typeof snapshot.nextControlHtml !== "string"
    || typeof snapshot.savedAt !== "number"
    || !Number.isFinite(snapshot.savedAt)
  ) return false;

  if (snapshot.page > snapshot.totalPages || snapshot.nextCount > snapshot.pageSize) return false;
  if (snapshot.pageSize > 24) return false;
  const renderedCount = (snapshot.photoIds as string[]).length;
  const maximumRenderedCount = Math.min(
    snapshot.totalItems as number,
    (snapshot.page as number) * (snapshot.pageSize as number),
  );
  if (renderedCount === 0 || renderedCount > maximumRenderedCount) return false;
  if (snapshot.terminal !== (snapshot.nextUrl === "")) return false;
  if (snapshot.terminal && snapshot.nextCount !== 0) return false;
  if (!snapshot.terminal && snapshot.nextCount === 0) return false;
  if (!snapshot.terminal && snapshot.nextControlHtml === "") return false;
  try {
    const entryUrl = new URL(snapshot.entryUrl);
    if (snapshot.nextUrl && new URL(snapshot.nextUrl, entryUrl).origin !== entryUrl.origin) return false;
  } catch {
    return false;
  }
  return true;
}

function parseIndex(storage: StorageLike | null): StoredIndexItem[] {
  if (!storage) return [];
  try {
    const serialized = storage.getItem(GALLERY_SNAPSHOT_INDEX_KEY) ?? "[]";
    if (utf8ByteLength(serialized) > MAX_INDEX_BYTES) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is StoredIndexItem => Boolean(
      item && typeof item === "object"
      && typeof (item as StoredIndexItem).key === "string"
      && isNonNegativeInteger((item as StoredIndexItem).bytes),
    ));
  } catch {
    return [];
  }
}

/** Bounded memory LRU mirrored to a guarded, oldest-first sessionStorage cache. */
export class GallerySnapshotStore {
  readonly #memory = new Map<string, { snapshot: GallerySnapshot; bytes: number }>();
  readonly #storage: StorageLike | null;
  readonly #limits: SnapshotLimits;

  constructor(storage: StorageLike | null, limits: Partial<SnapshotLimits> = {}) {
    this.#storage = storage;
    this.#limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...limits };
  }

  set(snapshot: GallerySnapshot): boolean {
    if (!isGallerySnapshot(snapshot)) return false;
    const serialized = JSON.stringify(snapshot);
    const bytes = utf8ByteLength(serialized);
    if (bytes > this.#limits.maxEntryBytes || bytes > this.#limits.maxTotalBytes) return false;

    this.#memory.delete(snapshot.key);
    this.#memory.set(snapshot.key, { snapshot, bytes });
    this.#evictMemory();
    this.#writeStorage(snapshot.key, serialized, bytes);
    return true;
  }

  get(key: string, scope: string, entryUrl?: string): GallerySnapshot | null {
    const memoryItem = this.#memory.get(key);
    if (memoryItem) {
      if (!isGallerySnapshot(memoryItem.snapshot, { key, scope, entryUrl })) {
        this.#memory.delete(key);
        return null;
      }
      this.#memory.delete(key);
      this.#memory.set(key, memoryItem);
      return memoryItem.snapshot;
    }

    if (!this.#storage) return null;
    try {
      const serialized = this.#storage.getItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${key}`);
      if (serialized === null || utf8ByteLength(serialized) > this.#limits.maxEntryBytes) return null;
      const parsed: unknown = JSON.parse(serialized);
      if (!isGallerySnapshot(parsed, { key, scope, entryUrl })) return null;
      this.#memory.set(key, { snapshot: parsed, bytes: utf8ByteLength(serialized) });
      this.#evictMemory();
      this.#touchStorageIndex(key, utf8ByteLength(serialized));
      return parsed;
    } catch {
      return null;
    }
  }

  memoryKeys(): string[] {
    return [...this.#memory.keys()];
  }

  /** Clear every bounded personalized card snapshot after viewer-state writes. */
  invalidateAll(): void {
    this.#memory.clear();
    if (!this.#storage) return;
    try {
      for (const item of parseIndex(this.#storage)) {
        this.#storage.removeItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${item.key}`);
      }
      this.#storage.removeItem(GALLERY_SNAPSHOT_INDEX_KEY);
    } catch {
      // Storage access can be blocked independently of the live UI. Reads still
      // validate scope and the server-refetched traversal remains authoritative.
    }
  }

  #evictMemory(): void {
    let total = [...this.#memory.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.#memory.size > this.#limits.maxEntries || total > this.#limits.maxTotalBytes) {
      const oldest = this.#memory.entries().next().value as [string, { bytes: number }] | undefined;
      if (!oldest) break;
      this.#memory.delete(oldest[0]);
      total -= oldest[1].bytes;
    }
  }

  #writeStorage(key: string, serialized: string, bytes: number): void {
    if (!this.#storage) return;
    try {
      this.#storage.setItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${key}`, serialized);
      if (!this.#touchStorageIndex(key, bytes)) {
        // Do not leave a newly-written record outside the bounded index when
        // its index update hits quota or another browser storage failure.
        try {
          this.#storage.removeItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${key}`);
        } catch {
          // Best effort is the only safe option when removal is also blocked.
        }
      }
    } catch {
      // Quota and privacy-mode failures must not affect the live gallery.
    }
  }

  #touchStorageIndex(key: string, bytes: number): boolean {
    if (!this.#storage) return false;
    try {
      const prior = parseIndex(this.#storage).flatMap((item) => {
        if (item.key === key) return [];
        const serialized = this.#storage?.getItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${item.key}`);
        if (serialized === null || serialized === undefined) return [];
        const actualBytes = utf8ByteLength(serialized);
        if (actualBytes > this.#limits.maxEntryBytes) {
          this.#storage?.removeItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${item.key}`);
          return [];
        }
        return [{ key: item.key, bytes: actualBytes }];
      });
      prior.push({ key, bytes });
      let total = prior.reduce((sum, item) => sum + item.bytes, 0);
      while (prior.length > this.#limits.maxEntries || total > this.#limits.maxTotalBytes) {
        const evicted = prior.shift();
        if (!evicted) break;
        total -= evicted.bytes;
        this.#storage.removeItem(`${GALLERY_SNAPSHOT_STORAGE_PREFIX}${evicted.key}`);
      }
      this.#storage.setItem(GALLERY_SNAPSHOT_INDEX_KEY, JSON.stringify(prior));
      return true;
    } catch {
      // A partially written cache is harmless; reads validate every record.
      return false;
    }
  }
}
