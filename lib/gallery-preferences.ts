export type ThumbnailRatio = "original" | "portrait" | "square" | "landscape";
export type ThumbnailWidth = "small" | "medium" | "large";

export type GalleryPreferences = {
  thumbRatio: ThumbnailRatio;
  thumbWidth: ThumbnailWidth;
};

export type GalleryPreferencesRecord = GalleryPreferences & {
  version: typeof GALLERY_PREFERENCES_VERSION;
};

export const GALLERY_PREFERENCES_VERSION = 1 as const;
export const GALLERY_PREFERENCES_STORAGE_KEY = "stillframe-gallery-preferences";
export const THUMB_RATIO_ATTRIBUTE = "data-thumb-ratio";
export const THUMB_WIDTH_ATTRIBUTE = "data-thumb-width";

export const THUMBNAIL_RATIO_OPTIONS = [
  { value: "original", label: "Original" },
  { value: "portrait", label: "Portrait 3:4" },
  { value: "square", label: "Square 1:1" },
  { value: "landscape", label: "Landscape 4:3" },
] as const satisfies ReadonlyArray<{ value: ThumbnailRatio; label: string }>;

export const THUMBNAIL_WIDTH_OPTIONS = [
  { value: "small", label: "Small", size: "9rem / 144px" },
  { value: "medium", label: "Medium", size: "12.5rem / 200px" },
  { value: "large", label: "Large", size: "16rem / 256px" },
] as const satisfies ReadonlyArray<{
  value: ThumbnailWidth;
  label: string;
  size: string;
}>;

export const DEFAULT_GALLERY_PREFERENCES: Readonly<GalleryPreferences> = {
  thumbRatio: "square",
  thumbWidth: "medium",
};

export function parseThumbnailRatio(value: unknown): ThumbnailRatio | null {
  return value === "original"
    || value === "portrait"
    || value === "square"
    || value === "landscape"
    ? value
    : null;
}

export function parseThumbnailWidth(value: unknown): ThumbnailWidth | null {
  return value === "small" || value === "medium" || value === "large"
    ? value
    : null;
}

export function parseGalleryPreferencesRecord(
  value: unknown,
): GalleryPreferences | null {
  try {
    let record: unknown = value;
    if (typeof value === "string") {
      record = JSON.parse(value);
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      return null;
    }

    const candidate = record as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (
      keys.length !== 3
      || !keys.includes("version")
      || !keys.includes("thumbRatio")
      || !keys.includes("thumbWidth")
      || candidate.version !== GALLERY_PREFERENCES_VERSION
    ) {
      return null;
    }

    const thumbRatio = parseThumbnailRatio(candidate.thumbRatio);
    const thumbWidth = parseThumbnailWidth(candidate.thumbWidth);
    return thumbRatio && thumbWidth ? { thumbRatio, thumbWidth } : null;
  } catch {
    // JSON parsing, proxies, and property getters are all untrusted input.
    return null;
  }
}

export function serializeGalleryPreferences(preferences: GalleryPreferences): string {
  return JSON.stringify({
    version: GALLERY_PREFERENCES_VERSION,
    thumbRatio: preferences.thumbRatio,
    thumbWidth: preferences.thumbWidth,
  } satisfies GalleryPreferencesRecord);
}

/** Build the guarded payload composed into the document's sole pre-paint script. */
export function buildGalleryPreferencesBootstrapScript(): string {
  return `(()=>{if(typeof document==="undefined")return;var r=document.documentElement;if(!r)return;var c=()=>{try{r.removeAttribute(${JSON.stringify(THUMB_RATIO_ATTRIBUTE)})}catch{}try{r.removeAttribute(${JSON.stringify(THUMB_WIDTH_ATTRIBUTE)})}catch{}};try{if(typeof localStorage==="undefined"){c();return}var s=localStorage.getItem(${JSON.stringify(GALLERY_PREFERENCES_STORAGE_KEY)});if(s===null){c();return}var v=JSON.parse(s);if(v===null||typeof v!=="object"||Array.isArray(v)||Object.keys(v).length!==3||v.version!==${GALLERY_PREFERENCES_VERSION}||(v.thumbRatio!=="original"&&v.thumbRatio!=="portrait"&&v.thumbRatio!=="square"&&v.thumbRatio!=="landscape")||(v.thumbWidth!=="small"&&v.thumbWidth!=="medium"&&v.thumbWidth!=="large")){c();return}r.setAttribute(${JSON.stringify(THUMB_RATIO_ATTRIBUTE)},v.thumbRatio);r.setAttribute(${JSON.stringify(THUMB_WIDTH_ATTRIBUTE)},v.thumbWidth)}catch{c()}})();`;
}

export const GALLERY_PREFERENCES_BOOTSTRAP_SCRIPT =
  buildGalleryPreferencesBootstrapScript();

export type GalleryPreferencesEnvironment = {
  readStoredPreferences(): unknown;
  writeStoredPreferences(value: string): void;
  applyRootPreferences(preferences: GalleryPreferences | null): void;
  subscribeStorageChange(listener: () => void): () => void;
};

export type GalleryPreferencesController = {
  start(): void;
  getPreferences(): GalleryPreferences;
  setPreferences(preferences: GalleryPreferences): GalleryPreferences;
  setRatio(ratio: ThumbnailRatio): GalleryPreferences;
  setWidth(width: ThumbnailWidth): GalleryPreferences;
  destroy(): void;
};

type RootPreferenceTarget = Pick<Element, "setAttribute" | "removeAttribute">;

function safely<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

function safelyRun(operation: () => void): void {
  try {
    operation();
  } catch {
    // Storage and DOM APIs can be blocked, absent, or replaced by host code.
  }
}

export function applyGalleryPreferencesToRoot(
  root: RootPreferenceTarget | null,
  preferences: GalleryPreferences | null,
): void {
  if (!root) return;
  if (preferences) {
    try {
      root.setAttribute(THUMB_RATIO_ATTRIBUTE, preferences.thumbRatio);
      root.setAttribute(THUMB_WIDTH_ATTRIBUTE, preferences.thumbWidth);
    } catch {
      // Do not leave a half-applied preference pair behind.
      safelyRun(() => root.removeAttribute(THUMB_RATIO_ATTRIBUTE));
      safelyRun(() => root.removeAttribute(THUMB_WIDTH_ATTRIBUTE));
    }
    return;
  }
  safelyRun(() => root.removeAttribute(THUMB_RATIO_ATTRIBUTE));
  safelyRun(() => root.removeAttribute(THUMB_WIDTH_ATTRIBUTE));
}

export function createGalleryPreferencesController(
  environment: GalleryPreferencesEnvironment,
  onChange: (preferences: GalleryPreferences) => void,
): GalleryPreferencesController {
  let current: GalleryPreferences = { ...DEFAULT_GALLERY_PREFERENCES };
  let started = false;
  let removeStorageListener: (() => void) | null = null;

  const notify = (next: GalleryPreferences) => {
    if (
      next.thumbRatio === current.thumbRatio
      && next.thumbWidth === current.thumbWidth
    ) return;
    current = next;
    onChange({ ...next });
  };

  const synchronize = () => {
    const parsed = parseGalleryPreferencesRecord(
      safely(() => environment.readStoredPreferences(), null),
    );
    safelyRun(() => environment.applyRootPreferences(parsed));
    notify(parsed ?? { ...DEFAULT_GALLERY_PREFERENCES });
  };

  const update = (preferences: GalleryPreferences) => {
    const next = {
      thumbRatio: parseThumbnailRatio(preferences.thumbRatio)
        ?? DEFAULT_GALLERY_PREFERENCES.thumbRatio,
      thumbWidth: parseThumbnailWidth(preferences.thumbWidth)
        ?? DEFAULT_GALLERY_PREFERENCES.thumbWidth,
    };
    notify(next);
    safelyRun(() => environment.applyRootPreferences(next));
    safelyRun(() => environment.writeStoredPreferences(
      serializeGalleryPreferences(next),
    ));
    return { ...next };
  };

  return {
    start() {
      if (started) return;
      started = true;
      removeStorageListener = safely(
        () => environment.subscribeStorageChange(synchronize),
        () => {},
      );
      synchronize();
    },

    getPreferences() {
      return { ...current };
    },

    setPreferences(preferences) {
      return update(preferences);
    },

    setRatio(thumbRatio) {
      return update({ ...current, thumbRatio });
    },

    setWidth(thumbWidth) {
      return update({ ...current, thumbWidth });
    },

    destroy() {
      if (!started) return;
      started = false;
      safelyRun(() => removeStorageListener?.());
      removeStorageListener = null;
    },
  };
}

export function createBrowserGalleryPreferencesEnvironment(): GalleryPreferencesEnvironment {
  return {
    readStoredPreferences: () =>
      window.localStorage.getItem(GALLERY_PREFERENCES_STORAGE_KEY),
    writeStoredPreferences: (value) =>
      window.localStorage.setItem(GALLERY_PREFERENCES_STORAGE_KEY, value),
    applyRootPreferences: (preferences) =>
      applyGalleryPreferencesToRoot(document.documentElement, preferences),
    subscribeStorageChange: (listener) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === GALLERY_PREFERENCES_STORAGE_KEY || event.key === null) {
          listener();
        }
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    },
  };
}
