import { describe, expect, it, vi } from "vitest";
import {
  applyGalleryPreferencesToRoot,
  buildGalleryPreferencesBootstrapScript,
  createBrowserGalleryPreferencesEnvironment,
  createGalleryPreferencesController,
  DEFAULT_GALLERY_PREFERENCES,
  GALLERY_PREFERENCES_STORAGE_KEY,
  GALLERY_PREFERENCES_VERSION,
  parseGalleryPreferencesRecord,
  parseThumbnailRatio,
  parseThumbnailWidth,
  serializeGalleryPreferences,
  THUMB_RATIO_ATTRIBUTE,
  THUMB_WIDTH_ATTRIBUTE,
  THUMBNAIL_RATIO_OPTIONS,
  THUMBNAIL_WIDTH_OPTIONS,
  type GalleryPreferences,
  type GalleryPreferencesEnvironment,
} from "../../lib/gallery-preferences";

function createEnvironment(
  overrides: Partial<GalleryPreferencesEnvironment> = {},
): GalleryPreferencesEnvironment {
  return {
    readStoredPreferences: () => null,
    writeStoredPreferences: () => {},
    applyRootPreferences: () => {},
    subscribeStorageChange: () => () => {},
    ...overrides,
  };
}

describe("gallery preference values", () => {
  it("exposes the exact semantic options and defaults", () => {
    expect(THUMBNAIL_RATIO_OPTIONS).toEqual([
      { value: "original", label: "Original" },
      { value: "portrait", label: "Portrait 3:4" },
      { value: "square", label: "Square 1:1" },
      { value: "landscape", label: "Landscape 4:3" },
    ]);
    expect(THUMBNAIL_WIDTH_OPTIONS).toEqual([
      { value: "small", label: "Small", size: "9rem / 144px" },
      { value: "medium", label: "Medium", size: "12.5rem / 200px" },
      { value: "large", label: "Large", size: "16rem / 256px" },
    ]);
    expect(DEFAULT_GALLERY_PREFERENCES).toEqual({
      thumbRatio: "square",
      thumbWidth: "medium",
    });
  });

  it("strictly parses only supported ratio and width values", () => {
    for (const value of ["original", "portrait", "square", "landscape"] as const) {
      expect(parseThumbnailRatio(value)).toBe(value);
    }
    for (const value of ["small", "medium", "large"] as const) {
      expect(parseThumbnailWidth(value)).toBe(value);
    }
    for (const invalid of [null, undefined, "Square", "wide", "", 1, {}]) {
      expect(parseThumbnailRatio(invalid)).toBeNull();
      expect(parseThumbnailWidth(invalid)).toBeNull();
    }
  });

  it("accepts only the current complete versioned schema", () => {
    const valid = { version: 1, thumbRatio: "portrait", thumbWidth: "large" };
    expect(parseGalleryPreferencesRecord(valid)).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "large",
    });
    expect(parseGalleryPreferencesRecord(JSON.stringify(valid))).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "large",
    });

    for (const invalid of [
      null,
      "not json",
      [],
      { ...valid, version: 2 },
      { ...valid, thumbRatio: "wide" },
      { ...valid, thumbWidth: "huge" },
      { version: 1, thumbRatio: "square" },
      { ...valid, futureField: true },
      new Proxy(valid, { ownKeys: () => { throw new Error("hostile proxy"); } }),
    ]) {
      expect(parseGalleryPreferencesRecord(invalid)).toBeNull();
    }
  });

  it("serializes a stable versioned storage record", () => {
    expect(GALLERY_PREFERENCES_VERSION).toBe(1);
    expect(JSON.parse(serializeGalleryPreferences({
      thumbRatio: "landscape",
      thumbWidth: "small",
    }))).toEqual({ version: 1, thumbRatio: "landscape", thumbWidth: "small" });
  });
});

describe("gallery preference root application and bootstrap", () => {
  it("applies valid values, clears both stale attributes, and contains DOM failures", () => {
    const setAttribute = vi.fn();
    const removeAttribute = vi.fn();
    const root = { setAttribute, removeAttribute };
    applyGalleryPreferencesToRoot(root as unknown as Element, {
      thumbRatio: "original",
      thumbWidth: "large",
    });
    expect(setAttribute).toHaveBeenCalledWith(THUMB_RATIO_ATTRIBUTE, "original");
    expect(setAttribute).toHaveBeenCalledWith(THUMB_WIDTH_ATTRIBUTE, "large");

    applyGalleryPreferencesToRoot(root as unknown as Element, null);
    expect(removeAttribute).toHaveBeenCalledWith(THUMB_RATIO_ATTRIBUTE);
    expect(removeAttribute).toHaveBeenCalledWith(THUMB_WIDTH_ATTRIBUTE);

    const partiallyRestricted = {
      setAttribute: vi.fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error("restricted"); }),
      removeAttribute: vi.fn(),
    };
    expect(() => applyGalleryPreferencesToRoot(
      partiallyRestricted as unknown as Element,
      { thumbRatio: "portrait", thumbWidth: "large" },
    )).not.toThrow();
    expect(partiallyRestricted.removeAttribute).toHaveBeenCalledWith(THUMB_RATIO_ATTRIBUTE);
    expect(partiallyRestricted.removeAttribute).toHaveBeenCalledWith(THUMB_WIDTH_ATTRIBUTE);
    expect(() => applyGalleryPreferencesToRoot(null, null)).not.toThrow();
  });

  it("runs before-paint code safely, applying valid state and clearing every invalid form", () => {
    const payload = buildGalleryPreferencesBootstrapScript();
    expect(payload).toContain(GALLERY_PREFERENCES_STORAGE_KEY);
    expect(() => Function(payload)()).not.toThrow();

    const attrs = new Map<string, string>([
      [THUMB_RATIO_ATTRIBUTE, "portrait"],
      [THUMB_WIDTH_ATTRIBUTE, "small"],
    ]);
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };
    const execute = Function("document", "localStorage", payload);
    execute(
      { documentElement: root },
      { getItem: () => serializeGalleryPreferences({ thumbRatio: "landscape", thumbWidth: "large" }) },
    );
    expect(Object.fromEntries(attrs)).toEqual({
      [THUMB_RATIO_ATTRIBUTE]: "landscape",
      [THUMB_WIDTH_ATTRIBUTE]: "large",
    });

    for (const stored of [null, "malformed", JSON.stringify({ version: 99 })]) {
      attrs.set(THUMB_RATIO_ATTRIBUTE, "portrait");
      attrs.set(THUMB_WIDTH_ATTRIBUTE, "small");
      execute({ documentElement: root }, { getItem: () => stored });
      expect(attrs.size).toBe(0);
    }

    attrs.set(THUMB_RATIO_ATTRIBUTE, "portrait");
    attrs.set(THUMB_WIDTH_ATTRIBUTE, "small");
    expect(() => execute(
      { documentElement: root },
      { getItem: () => { throw new Error("blocked"); } },
    )).not.toThrow();
    expect(attrs.size).toBe(0);
  });
});

describe("gallery preference controller", () => {
  it("loads valid storage, writes changes, and removes its listener", () => {
    const writes: string[] = [];
    const roots: Array<GalleryPreferences | null> = [];
    const changes: GalleryPreferences[] = [];
    const remove = vi.fn();
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => serializeGalleryPreferences({
        thumbRatio: "portrait",
        thumbWidth: "small",
      }),
      writeStoredPreferences: (value) => writes.push(value),
      applyRootPreferences: (value) => roots.push(value),
      subscribeStorageChange: () => remove,
    }), (value) => changes.push(value));

    controller.start();
    expect(controller.getPreferences()).toEqual({ thumbRatio: "portrait", thumbWidth: "small" });
    expect(roots).toEqual([{ thumbRatio: "portrait", thumbWidth: "small" }]);
    expect(changes).toEqual([{ thumbRatio: "portrait", thumbWidth: "small" }]);

    controller.setWidth("large");
    expect(JSON.parse(writes[0])).toEqual({
      version: 1,
      thumbRatio: "portrait",
      thumbWidth: "large",
    });
    expect(controller.getPreferences()).toEqual({ thumbRatio: "portrait", thumbWidth: "large" });
    controller.destroy();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("clears invalid, deleted, and inaccessible state and synchronizes cross-tab updates", () => {
    let stored: unknown = "malformed";
    let storageBlocked = false;
    let storageListener: (() => void) | undefined;
    const roots: Array<GalleryPreferences | null> = [];
    const changes: GalleryPreferences[] = [];
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => {
        if (storageBlocked) throw new Error("blocked");
        return stored;
      },
      applyRootPreferences: (value) => roots.push(value),
      subscribeStorageChange: (listener) => {
        storageListener = listener;
        return () => {};
      },
    }), (value) => changes.push(value));

    controller.start();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
    expect(roots).toEqual([null]);

    stored = serializeGalleryPreferences({ thumbRatio: "original", thumbWidth: "large" });
    storageListener?.();
    expect(controller.getPreferences()).toEqual({ thumbRatio: "original", thumbWidth: "large" });

    stored = null;
    storageListener?.();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
    expect(roots.at(-1)).toBeNull();
    expect(changes).toEqual([
      { thumbRatio: "original", thumbWidth: "large" },
      { thumbRatio: "square", thumbWidth: "medium" },
    ]);

    storageBlocked = true;
    expect(() => storageListener?.()).not.toThrow();
    expect(roots.at(-1)).toBeNull();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
  });

  it("contains every restricted adapter operation", () => {
    const restricted = () => { throw new Error("restricted"); };
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: restricted,
      writeStoredPreferences: restricted,
      applyRootPreferences: restricted,
      subscribeStorageChange: restricted,
    }), () => {});
    expect(() => controller.start()).not.toThrow();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
    expect(() => controller.setRatio("landscape")).not.toThrow();
    expect(() => controller.destroy()).not.toThrow();
  });

  it("filters native storage events to this key or a storage clear", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("window", { addEventListener, removeEventListener });
    const environment = createBrowserGalleryPreferencesEnvironment();
    const listener = vi.fn();
    const remove = environment.subscribeStorageChange(listener);
    const handler = addEventListener.mock.calls[0]?.[1] as (event: StorageEvent) => void;
    handler({ key: "other" } as StorageEvent);
    handler({ key: GALLERY_PREFERENCES_STORAGE_KEY } as StorageEvent);
    handler({ key: null } as StorageEvent);
    expect(listener).toHaveBeenCalledTimes(2);
    remove();
    expect(removeEventListener).toHaveBeenCalledWith("storage", handler);
    vi.unstubAllGlobals();
  });
});
