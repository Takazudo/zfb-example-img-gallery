"use client";

import { useEffect, useRef, useState } from "preact/hooks";
import {
  createBrowserThemeEnvironment,
  createThemeController,
  getThemeToggleLabel,
  type ThemeController,
  type ThemeMode,
} from "../lib/theme";

export function ThemeToggle() {
  // This fixed server/client-first value keeps hydration deterministic. The
  // controller reconciles it with pre-paint and system state after mount.
  const [theme, setTheme] = useState<ThemeMode>("light");
  const controller = useRef<ThemeController | null>(null);

  useEffect(() => {
    const nextController = createThemeController(
      createBrowserThemeEnvironment(),
      setTheme,
    );
    controller.current = nextController;
    nextController.start();

    return () => {
      controller.current = null;
      nextController.destroy();
    };
  }, []);

  return (
    <button
      type="button"
      aria-label={getThemeToggleLabel(theme)}
      class="inline-flex min-h-[2.75rem] min-w-[2.75rem] cursor-pointer items-center justify-center rounded-md text-ink transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      onClick={() => controller.current?.toggle()}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        {theme === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
          </>
        ) : (
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
        )}
      </svg>
    </button>
  );
}

ThemeToggle.displayName = "ThemeToggle";
