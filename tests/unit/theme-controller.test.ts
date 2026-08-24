import { describe, expect, it, vi } from "vitest";
import {
  buildThemeBootstrapScript,
  createThemeController,
  getEffectiveTheme,
  getNextTheme,
  getThemeToggleLabel,
  parseThemeMode,
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  type ThemeControllerEnvironment,
  type ThemeMode,
} from "../../lib/theme";

function createEnvironment(
  overrides: Partial<ThemeControllerEnvironment> = {},
): ThemeControllerEnvironment {
  return {
    readStoredTheme: () => null,
    readRootTheme: () => null,
    prefersDark: () => false,
    writeStoredTheme: () => {},
    writeRootTheme: () => {},
    dispatchThemeChange: () => {},
    subscribeSystemPreference: () => () => {},
    subscribeThemeChange: () => () => {},
    ...overrides,
  };
}

describe("theme helpers", () => {
  it("strictly parses only supported theme modes", () => {
    expect(parseThemeMode("light")).toBe("light");
    expect(parseThemeMode("dark")).toBe("dark");
    for (const invalid of [null, undefined, "LIGHT", "system", "", 1, {}]) {
      expect(parseThemeMode(invalid)).toBeNull();
    }
  });

  it("selects effective and next modes and next-action labels", () => {
    expect(getEffectiveTheme("light", true)).toBe("light");
    expect(getEffectiveTheme("dark", false)).toBe("dark");
    expect(getEffectiveTheme(null, true)).toBe("dark");
    expect(getEffectiveTheme(null, false)).toBe("light");
    expect(getNextTheme("light")).toBe("dark");
    expect(getNextTheme("dark")).toBe("light");
    expect(getThemeToggleLabel("light")).toBe("Switch to dark mode");
    expect(getThemeToggleLabel("dark")).toBe("Switch to light mode");
  });

  it("builds a project-owned, guarded pre-paint payload", () => {
    const payload = buildThemeBootstrapScript();
    expect(THEME_STORAGE_KEY).toBe("stillframe-theme");
    expect(THEME_CHANGE_EVENT).toBe("stillframe:theme-change");
    expect(payload).toContain("try{");
    expect(payload).toContain(`localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})`);
    expect(payload).toContain('v==="light"||v==="dark"');
    expect(payload).not.toContain("matchMedia");
  });

  it("runs the bootstrap safely and applies only valid saved choices", () => {
    const payload = buildThemeBootstrapScript();
    expect(() => Function(payload)()).not.toThrow();

    const setAttribute = vi.fn();
    const execute = Function("document", "localStorage", payload);
    execute(
      { documentElement: { setAttribute } },
      { getItem: () => "sepia" },
    );
    expect(setAttribute).not.toHaveBeenCalled();

    execute(
      { documentElement: { setAttribute } },
      { getItem: () => "dark" },
    );
    expect(setAttribute).toHaveBeenCalledWith("data-theme", "dark");
    expect(() =>
      execute(
        { documentElement: { setAttribute } },
        { getItem: () => { throw new Error("restricted"); } },
      ),
    ).not.toThrow();
  });
});

describe("theme controller", () => {
  it("starts from the root pre-paint value and cleans up listeners", () => {
    const removeTheme = vi.fn();
    const removeSystem = vi.fn();
    const subscribeTheme = vi.fn(() => removeTheme);
    const subscribeSystem = vi.fn(() => removeSystem);
    const changes: ThemeMode[] = [];
    const controller = createThemeController(
      createEnvironment({
        readRootTheme: () => "dark",
        subscribeThemeChange: subscribeTheme,
        subscribeSystemPreference: subscribeSystem,
      }),
      (theme) => changes.push(theme),
    );

    controller.start();
    expect(controller.getMode()).toBe("dark");
    expect(changes).toEqual(["dark"]);
    expect(subscribeTheme).toHaveBeenCalledOnce();
    expect(subscribeSystem).not.toHaveBeenCalled();

    controller.destroy();
    expect(removeTheme).toHaveBeenCalledOnce();
    expect(removeSystem).not.toHaveBeenCalled();
  });

  it("tracks live system preference only while no explicit choice exists", () => {
    let prefersDark = false;
    let systemListener: (() => void) | undefined;
    const removeSystem = vi.fn();
    const rootWrites: ThemeMode[] = [];
    const storageWrites: ThemeMode[] = [];
    const events: ThemeMode[] = [];
    const changes: ThemeMode[] = [];
    const controller = createThemeController(
      createEnvironment({
        prefersDark: () => prefersDark,
        writeRootTheme: (theme) => rootWrites.push(theme),
        writeStoredTheme: (theme) => storageWrites.push(theme),
        dispatchThemeChange: (theme) => events.push(theme),
        subscribeSystemPreference: (listener) => {
          systemListener = listener;
          return removeSystem;
        },
      }),
      (theme) => changes.push(theme),
    );

    controller.start();
    prefersDark = true;
    systemListener?.();
    expect(controller.getMode()).toBe("dark");

    expect(controller.toggle()).toBe("light");
    expect(rootWrites).toEqual(["light"]);
    expect(storageWrites).toEqual(["light"]);
    expect(events).toEqual(["light"]);
    expect(removeSystem).toHaveBeenCalledOnce();

    prefersDark = false;
    systemListener?.();
    expect(controller.getMode()).toBe("light");
    expect(changes).toEqual(["dark", "light"]);
  });

  it("keeps a saved explicit choice ahead of OS changes", () => {
    const subscribeSystem = vi.fn(() => () => {});
    const controller = createThemeController(
      createEnvironment({
        readStoredTheme: () => "dark",
        prefersDark: () => false,
        subscribeSystemPreference: subscribeSystem,
      }),
      () => {},
    );
    controller.start();
    expect(controller.getMode()).toBe("dark");
    expect(subscribeSystem).not.toHaveBeenCalled();
  });

  it("synchronizes other listeners through the project-owned change event", () => {
    let storedTheme: ThemeMode | null = null;
    let rootTheme: ThemeMode | null = null;
    let themeListener: (() => void) | undefined;
    const changes: ThemeMode[] = [];
    const controller = createThemeController(
      createEnvironment({
        readStoredTheme: () => storedTheme,
        readRootTheme: () => rootTheme,
        subscribeThemeChange: (listener) => {
          themeListener = listener;
          return () => {};
        },
      }),
      (theme) => changes.push(theme),
    );
    controller.start();

    storedTheme = "dark";
    rootTheme = "dark";
    themeListener?.();
    expect(controller.getMode()).toBe("dark");
    expect(changes).toEqual(["dark"]);
  });

  it("ignores invalid state and safely contains restricted browser adapters", () => {
    const restricted = () => {
      throw new Error("restricted");
    };
    const controller = createThemeController(
      createEnvironment({
        readStoredTheme: () => "sepia",
        readRootTheme: restricted,
        prefersDark: restricted,
        writeStoredTheme: restricted,
        writeRootTheme: restricted,
        dispatchThemeChange: restricted,
        subscribeSystemPreference: restricted,
        subscribeThemeChange: restricted,
      }),
      () => {},
    );
    expect(() => controller.start()).not.toThrow();
    expect(controller.getMode()).toBe("light");
    expect(() => controller.toggle()).not.toThrow();
    expect(controller.getMode()).toBe("dark");
    expect(() => controller.destroy()).not.toThrow();
  });
});
