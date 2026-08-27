import { describe, expect, it, vi } from "vitest";
import {
  applyGalleryPreferencesToRoot,
  buildGalleryPreferencesBootstrapScript,
  createBrowserGalleryPreferencesEnvironment,
  createGalleryPreferencesController,
  DEFAULT_GALLERY_PREFERENCES,
  GALLERY_LAYOUT_ATTRIBUTE,
  GALLERY_LAYOUT_OPTIONS,
  GALLERY_PREFERENCES_STORAGE_KEY,
  GALLERY_PREFERENCES_VERSION,
  parseGalleryLayoutMode,
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

function preferences(
  overrides: Partial<GalleryPreferences> = {},
): GalleryPreferences {
  return { ...DEFAULT_GALLERY_PREFERENCES, ...overrides };
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
    expect(GALLERY_LAYOUT_OPTIONS).toEqual([
      { value: "uniform", label: "Uniform" },
      { value: "spotlight", label: "Spotlight" },
      { value: "editorial", label: "Editorial" },
      { value: "justified", label: "Justified" },
      { value: "masonry", label: "Masonry" },
    ]);
    expect(DEFAULT_GALLERY_PREFERENCES).toEqual({
      thumbRatio: "square",
      thumbWidth: "medium",
      galleryLayout: "uniform",
    });
  });

  it("strictly parses only supported ratio, width, and layout values", () => {
    for (const value of ["original", "portrait", "square", "landscape"] as const) {
      expect(parseThumbnailRatio(value)).toBe(value);
    }
    for (const value of ["small", "medium", "large"] as const) {
      expect(parseThumbnailWidth(value)).toBe(value);
    }
    for (const value of ["uniform", "spotlight", "editorial", "justified", "masonry"] as const) {
      expect(parseGalleryLayoutMode(value)).toBe(value);
    }
    for (const invalid of [null, undefined, "Uniform", "wide", "", 1, {}]) {
      expect(parseThumbnailRatio(invalid)).toBeNull();
      expect(parseThumbnailWidth(invalid)).toBeNull();
      expect(parseGalleryLayoutMode(invalid)).toBeNull();
    }
  });

  it("accepts the separate exact v1 and v2 schemas", () => {
    const validV1 = { version: 1, thumbRatio: "portrait", thumbWidth: "large" };
    const validV2 = {
      version: 2,
      thumbRatio: "original",
      thumbWidth: "small",
      galleryLayout: "editorial",
    };
    expect(parseGalleryPreferencesRecord(validV1)).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "large",
      galleryLayout: "uniform",
    });
    expect(parseGalleryPreferencesRecord(JSON.stringify(validV1))).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "large",
      galleryLayout: "uniform",
    });
    expect(parseGalleryPreferencesRecord(validV2)).toEqual({
      thumbRatio: "original",
      thumbWidth: "small",
      galleryLayout: "editorial",
    });
    expect(parseGalleryPreferencesRecord(JSON.stringify(validV2))).toEqual({
      thumbRatio: "original",
      thumbWidth: "small",
      galleryLayout: "editorial",
    });
  });

  it("rejects malformed, incomplete, extra, invalid, and hostile records without throwing", () => {
    const validV1 = { version: 1, thumbRatio: "portrait", thumbWidth: "large" };
    const validV2 = {
      version: 2,
      thumbRatio: "portrait",
      thumbWidth: "large",
      galleryLayout: "spotlight",
    };
    const throwingGetter = Object.defineProperty(
      { version: 2, thumbRatio: "portrait", thumbWidth: "large" },
      "galleryLayout",
      { enumerable: true, get: () => { throw new Error("hostile getter"); } },
    );

    for (const invalid of [
      null,
      "not json",
      [],
      { ...validV1, version: 0 },
      { ...validV1, thumbRatio: "wide" },
      { ...validV1, thumbWidth: "huge" },
      { version: 1, thumbRatio: "square" },
      { ...validV1, galleryLayout: "uniform" },
      { ...validV1, futureField: true },
      { ...validV2, thumbRatio: "wide" },
      { ...validV2, thumbWidth: "huge" },
      { ...validV2, galleryLayout: "tiles" },
      { version: 2, thumbRatio: "square", thumbWidth: "medium" },
      { ...validV2, futureField: true },
      throwingGetter,
      new Proxy(validV2, { ownKeys: () => { throw new Error("hostile proxy"); } }),
      new Proxy(validV2, { get: () => { throw new Error("hostile proxy getter"); } }),
    ]) {
      expect(() => parseGalleryPreferencesRecord(invalid)).not.toThrow();
      expect(parseGalleryPreferencesRecord(invalid)).toBeNull();
    }
  });

  it("serializes the stable canonical v2 storage record", () => {
    expect(GALLERY_PREFERENCES_VERSION).toBe(2);
    expect(JSON.parse(serializeGalleryPreferences({
      thumbRatio: "landscape",
      thumbWidth: "small",
      galleryLayout: "masonry",
    }))).toEqual({
      version: 2,
      thumbRatio: "landscape",
      thumbWidth: "small",
      galleryLayout: "masonry",
    });
  });
});

describe("gallery preference root application and bootstrap", () => {
  it("applies and clears all values atomically while containing DOM failures", () => {
    const setAttribute = vi.fn();
    const removeAttribute = vi.fn();
    const root = { setAttribute, removeAttribute };
    applyGalleryPreferencesToRoot(root as unknown as Element, preferences({
      thumbRatio: "original",
      thumbWidth: "large",
      galleryLayout: "justified",
    }));
    expect(setAttribute).toHaveBeenCalledWith(THUMB_RATIO_ATTRIBUTE, "original");
    expect(setAttribute).toHaveBeenCalledWith(THUMB_WIDTH_ATTRIBUTE, "large");
    expect(setAttribute).toHaveBeenCalledWith(GALLERY_LAYOUT_ATTRIBUTE, "justified");

    applyGalleryPreferencesToRoot(root as unknown as Element, null);
    for (const attribute of [
      THUMB_RATIO_ATTRIBUTE,
      THUMB_WIDTH_ATTRIBUTE,
      GALLERY_LAYOUT_ATTRIBUTE,
    ]) expect(removeAttribute).toHaveBeenCalledWith(attribute);

    const partiallyRestricted = {
      setAttribute: vi.fn()
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => { throw new Error("restricted"); }),
      removeAttribute: vi.fn(),
    };
    expect(() => applyGalleryPreferencesToRoot(
      partiallyRestricted as unknown as Element,
      preferences({ thumbRatio: "portrait", thumbWidth: "large", galleryLayout: "spotlight" }),
    )).not.toThrow();
    for (const attribute of [
      THUMB_RATIO_ATTRIBUTE,
      THUMB_WIDTH_ATTRIBUTE,
      GALLERY_LAYOUT_ATTRIBUTE,
    ]) expect(partiallyRestricted.removeAttribute).toHaveBeenCalledWith(attribute);

    expect(() => applyGalleryPreferencesToRoot({
      setAttribute: () => { throw new Error("restricted"); },
      removeAttribute: () => { throw new Error("restricted"); },
    }, preferences())).not.toThrow();
    expect(() => applyGalleryPreferencesToRoot(null, null)).not.toThrow();
  });

  it("applies exact v1 and v2 records before paint without writing storage", () => {
    const payload = buildGalleryPreferencesBootstrapScript();
    expect(payload).toContain(GALLERY_PREFERENCES_STORAGE_KEY);
    expect(payload).not.toContain("setItem");
    expect(() => Function(payload)()).not.toThrow();

    const attrs = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };
    const execute = Function("document", "localStorage", payload);

    execute(
      { documentElement: root },
      { getItem: () => JSON.stringify({ version: 1, thumbRatio: "portrait", thumbWidth: "small" }) },
    );
    expect(Object.fromEntries(attrs)).toEqual({
      [THUMB_RATIO_ATTRIBUTE]: "portrait",
      [THUMB_WIDTH_ATTRIBUTE]: "small",
      [GALLERY_LAYOUT_ATTRIBUTE]: "uniform",
    });

    execute(
      { documentElement: root },
      { getItem: () => serializeGalleryPreferences(preferences({
        thumbRatio: "landscape",
        thumbWidth: "large",
        galleryLayout: "masonry",
      })) },
    );
    expect(Object.fromEntries(attrs)).toEqual({
      [THUMB_RATIO_ATTRIBUTE]: "landscape",
      [THUMB_WIDTH_ATTRIBUTE]: "large",
      [GALLERY_LAYOUT_ATTRIBUTE]: "masonry",
    });
  });

  it("clears every attribute for invalid, deleted, unavailable, or partially applied state", () => {
    const payload = buildGalleryPreferencesBootstrapScript();
    const attrs = new Map<string, string>();
    const seed = () => {
      attrs.set(THUMB_RATIO_ATTRIBUTE, "portrait");
      attrs.set(THUMB_WIDTH_ATTRIBUTE, "small");
      attrs.set(GALLERY_LAYOUT_ATTRIBUTE, "spotlight");
    };
    const root = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
    };
    const execute = Function("document", "localStorage", payload);
    const invalidRecords = [
      null,
      "malformed",
      JSON.stringify({ version: 99 }),
      JSON.stringify({ version: 1, thumbRatio: "portrait", thumbWidth: "small", extra: true }),
      JSON.stringify({ version: 2, thumbRatio: "portrait", thumbWidth: "small" }),
      JSON.stringify({
        version: 2,
        thumbRatio: "portrait",
        thumbWidth: "small",
        galleryLayout: "tiles",
      }),
    ];
    for (const stored of invalidRecords) {
      seed();
      execute({ documentElement: root }, { getItem: () => stored });
      expect(attrs.size).toBe(0);
    }

    seed();
    expect(() => execute(
      { documentElement: root },
      { getItem: () => { throw new Error("blocked"); } },
    )).not.toThrow();
    expect(attrs.size).toBe(0);

    seed();
    execute({ documentElement: root }, undefined);
    expect(attrs.size).toBe(0);

    const removeAttribute = vi.fn();
    let setCalls = 0;
    expect(() => execute({
      documentElement: {
        setAttribute: () => {
          setCalls += 1;
          if (setCalls === 2) throw new Error("restricted");
        },
        removeAttribute,
      },
    }, {
      getItem: () => serializeGalleryPreferences(preferences({ galleryLayout: "editorial" })),
    })).not.toThrow();
    for (const attribute of [
      THUMB_RATIO_ATTRIBUTE,
      THUMB_WIDTH_ATTRIBUTE,
      GALLERY_LAYOUT_ATTRIBUTE,
    ]) expect(removeAttribute).toHaveBeenCalledWith(attribute);
  });
});

describe("gallery preference controller", () => {
  it("loads v2 storage, writes immediate changes, and removes its listener", () => {
    const writes: string[] = [];
    const roots: Array<GalleryPreferences | null> = [];
    const changes: GalleryPreferences[] = [];
    const remove = vi.fn();
    const initial = preferences({
      thumbRatio: "portrait",
      thumbWidth: "small",
      galleryLayout: "spotlight",
    });
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => serializeGalleryPreferences(initial),
      writeStoredPreferences: (value) => writes.push(value),
      applyRootPreferences: (value) => roots.push(value),
      subscribeStorageChange: () => remove,
    }), (value) => changes.push(value));

    controller.start();
    expect(controller.getPreferences()).toEqual(initial);
    expect(roots).toEqual([initial]);
    expect(changes).toEqual([initial]);
    expect(writes).toEqual([]);

    controller.setWidth("large");
    controller.setRatio("original");
    controller.setLayout("masonry");
    expect(JSON.parse(writes.at(-1) ?? "null")).toEqual({
      version: 2,
      thumbRatio: "original",
      thumbWidth: "large",
      galleryLayout: "masonry",
    });
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "original",
      thumbWidth: "large",
      galleryLayout: "masonry",
    });
    expect(roots.at(-1)).toEqual(controller.getPreferences());
    controller.destroy();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("migrates valid v1 once on startup without storage-event rewrite loops", () => {
    const legacy = JSON.stringify({
      version: 1,
      thumbRatio: "portrait",
      thumbWidth: "large",
    });
    let storageListener: (() => void) | undefined;
    let writes = 0;
    const roots: Array<GalleryPreferences | null> = [];
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => legacy,
      writeStoredPreferences: (value) => {
        writes += 1;
        expect(JSON.parse(value)).toEqual({
          version: 2,
          thumbRatio: "portrait",
          thumbWidth: "large",
          galleryLayout: "uniform",
        });
        storageListener?.();
      },
      applyRootPreferences: (value) => roots.push(value),
      subscribeStorageChange: (listener) => {
        storageListener = listener;
        return () => {};
      },
    }), () => {});

    controller.start();
    controller.start();
    expect(writes).toBe(1);
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "large",
      galleryLayout: "uniform",
    });
    expect(roots.every((root) => root?.galleryLayout === "uniform")).toBe(true);

    storageListener?.();
    expect(writes).toBe(1);
  });

  it("keeps migrated in-memory and root state when the canonical write fails", () => {
    const roots: Array<GalleryPreferences | null> = [];
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => JSON.stringify({
        version: 1,
        thumbRatio: "landscape",
        thumbWidth: "small",
      }),
      writeStoredPreferences: () => { throw new Error("quota"); },
      applyRootPreferences: (value) => roots.push(value),
    }), () => {});

    expect(() => controller.start()).not.toThrow();
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "landscape",
      thumbWidth: "small",
      galleryLayout: "uniform",
    });
    expect(roots.at(-1)).toEqual(controller.getPreferences());
  });

  it("clears invalid, deleted, and inaccessible state and synchronizes cross-tab updates", () => {
    let stored: unknown = "malformed";
    let storageBlocked = false;
    let storageListener: (() => void) | undefined;
    const roots: Array<GalleryPreferences | null> = [];
    const changes: GalleryPreferences[] = [];
    const writes: string[] = [];
    const controller = createGalleryPreferencesController(createEnvironment({
      readStoredPreferences: () => {
        if (storageBlocked) throw new Error("blocked");
        return stored;
      },
      writeStoredPreferences: (value) => writes.push(value),
      applyRootPreferences: (value) => roots.push(value),
      subscribeStorageChange: (listener) => {
        storageListener = listener;
        return () => {};
      },
    }), (value) => changes.push(value));

    controller.start();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
    expect(roots).toEqual([null]);

    stored = serializeGalleryPreferences(preferences({
      thumbRatio: "original",
      thumbWidth: "large",
      galleryLayout: "editorial",
    }));
    storageListener?.();
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "original",
      thumbWidth: "large",
      galleryLayout: "editorial",
    });

    stored = JSON.stringify({ version: 1, thumbRatio: "portrait", thumbWidth: "small" });
    storageListener?.();
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "portrait",
      thumbWidth: "small",
      galleryLayout: "uniform",
    });
    expect(writes).toEqual([]);

    stored = null;
    storageListener?.();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
    expect(roots.at(-1)).toBeNull();
    expect(changes).toEqual([
      { thumbRatio: "original", thumbWidth: "large", galleryLayout: "editorial" },
      { thumbRatio: "portrait", thumbWidth: "small", galleryLayout: "uniform" },
      { thumbRatio: "square", thumbWidth: "medium", galleryLayout: "uniform" },
    ]);

    storageBlocked = true;
    expect(() => storageListener?.()).not.toThrow();
    expect(roots.at(-1)).toBeNull();
    expect(controller.getPreferences()).toEqual(DEFAULT_GALLERY_PREFERENCES);
  });

  it("contains every restricted adapter operation without undoing immediate state", () => {
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
    expect(() => controller.setLayout("justified")).not.toThrow();
    expect(controller.getPreferences()).toEqual({
      thumbRatio: "landscape",
      thumbWidth: "medium",
      galleryLayout: "justified",
    });
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
