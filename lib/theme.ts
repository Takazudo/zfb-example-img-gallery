export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "stillframe-theme";
export const THEME_CHANGE_EVENT = "stillframe:theme-change";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function parseThemeMode(value: unknown): ThemeMode | null {
  return value === "light" || value === "dark" ? value : null;
}

export function getEffectiveTheme(
  explicitTheme: ThemeMode | null,
  prefersDark: boolean,
): ThemeMode {
  return explicitTheme ?? (prefersDark ? "dark" : "light");
}

export function getNextTheme(currentTheme: ThemeMode): ThemeMode {
  return currentTheme === "light" ? "dark" : "light";
}

export function getThemeToggleLabel(currentTheme: ThemeMode): string {
  return `Switch to ${getNextTheme(currentTheme)} mode`;
}

/**
 * Inline this payload in the document head before the stylesheet. It is kept
 * as a builder so importing this module during SSR never reads browser state.
 */
export function buildThemeBootstrapScript(): string {
  return `(()=>{try{if(typeof document==="undefined"||typeof localStorage==="undefined")return;var r=document.documentElement;if(!r)return;var v=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(v==="light"||v==="dark")r.setAttribute("data-theme",v)}catch{}})();`;
}

export const THEME_BOOTSTRAP_SCRIPT = buildThemeBootstrapScript();

export type ThemeControllerEnvironment = {
  readStoredTheme(): unknown;
  readRootTheme(): unknown;
  prefersDark(): boolean;
  writeStoredTheme(theme: ThemeMode): void;
  writeRootTheme(theme: ThemeMode): void;
  dispatchThemeChange(theme: ThemeMode): void;
  subscribeSystemPreference(listener: () => void): () => void;
  subscribeThemeChange(listener: () => void): () => void;
};

export type ThemeController = {
  start(): void;
  toggle(): ThemeMode;
  getMode(): ThemeMode;
  destroy(): void;
};

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
    // Storage, DOM, and event APIs can be unavailable or restricted.
  }
}

export function createThemeController(
  environment: ThemeControllerEnvironment,
  onChange: (theme: ThemeMode) => void,
): ThemeController {
  let currentTheme: ThemeMode = "light";
  let explicitTheme: ThemeMode | null = null;
  let started = false;
  let removeSystemListener: (() => void) | null = null;
  let removeThemeListener: (() => void) | null = null;

  const notify = (theme: ThemeMode) => {
    if (theme === currentTheme) return;
    currentTheme = theme;
    onChange(theme);
  };

  const stopSystemListener = () => {
    safelyRun(() => removeSystemListener?.());
    removeSystemListener = null;
  };

  const handleSystemChange = () => {
    if (explicitTheme !== null) return;
    notify(getEffectiveTheme(null, safely(() => environment.prefersDark(), false)));
  };

  const updateSystemSubscription = () => {
    stopSystemListener();
    if (started && explicitTheme === null) {
      removeSystemListener = safely(
        () => environment.subscribeSystemPreference(handleSystemChange),
        () => {},
      );
    }
  };

  const synchronize = () => {
    const storedTheme = parseThemeMode(
      safely(() => environment.readStoredTheme(), null),
    );
    const rootTheme = parseThemeMode(
      safely(() => environment.readRootTheme(), null),
    );

    // A valid root value is the pre-paint result and remains useful if a later
    // storage read is restricted. Invalid DOM and storage values are ignored.
    explicitTheme = storedTheme ?? rootTheme;
    notify(
      rootTheme ??
        getEffectiveTheme(
          explicitTheme,
          safely(() => environment.prefersDark(), false),
        ),
    );
    updateSystemSubscription();
  };

  return {
    start() {
      if (started) return;
      started = true;
      removeThemeListener = safely(
        () => environment.subscribeThemeChange(synchronize),
        () => {},
      );
      synchronize();
    },

    toggle() {
      const nextTheme = getNextTheme(currentTheme);
      explicitTheme = nextTheme;
      notify(nextTheme);
      updateSystemSubscription();
      safelyRun(() => environment.writeRootTheme(nextTheme));
      safelyRun(() => environment.writeStoredTheme(nextTheme));
      safelyRun(() => environment.dispatchThemeChange(nextTheme));
      return nextTheme;
    },

    getMode() {
      return currentTheme;
    },

    destroy() {
      if (!started) return;
      started = false;
      stopSystemListener();
      safelyRun(() => removeThemeListener?.());
      removeThemeListener = null;
    },
  };
}

export function createBrowserThemeEnvironment(): ThemeControllerEnvironment {
  return {
    readStoredTheme: () => window.localStorage.getItem(THEME_STORAGE_KEY),
    readRootTheme: () => document.documentElement.getAttribute("data-theme"),
    prefersDark: () => window.matchMedia(THEME_MEDIA_QUERY).matches,
    writeStoredTheme: (theme) => window.localStorage.setItem(THEME_STORAGE_KEY, theme),
    writeRootTheme: (theme) => document.documentElement.setAttribute("data-theme", theme),
    dispatchThemeChange: (theme) => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
    },
    subscribeSystemPreference: (listener) => {
      const media = window.matchMedia(THEME_MEDIA_QUERY);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    subscribeThemeChange: (listener) => {
      window.addEventListener(THEME_CHANGE_EVENT, listener);
      return () => window.removeEventListener(THEME_CHANGE_EVENT, listener);
    },
  };
}
