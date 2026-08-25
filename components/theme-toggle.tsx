"use client";

import { useEffect, useRef, useState } from "preact/hooks";
import {
  createBrowserThemeEnvironment,
  createThemeController,
  getThemeToggleLabel,
  type ThemeController,
  type ThemeMode,
} from "../lib/theme";
import { MoonIcon, SunIcon } from "./icons";

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
      class="inline-flex min-h-[2.75rem] min-w-[2.75rem] cursor-pointer items-center justify-center rounded-md group relative text-ink-soft hover:text-ink transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      onClick={() => controller.current?.toggle()}
    >
      {theme === "light" ? <SunIcon class="size-5" /> : <MoonIcon class="size-5" />}
      <span
        aria-hidden="true"
        class="pointer-events-none absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-hsp-xs py-hsp-2xs text-micro font-medium text-paper opacity-0 transition-opacity delay-200 [.group:hover_&]:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100"
      >
        {getThemeToggleLabel(theme)}
      </span>
    </button>
  );
}

ThemeToggle.displayName = "ThemeToggle";
