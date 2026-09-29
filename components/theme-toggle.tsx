"use client";

import { computed, getScope, Show, signal } from "@takazudo/zfb/zudo-react";
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
  // controller reconciles it with pre-paint and system state after activation.
  const theme = signal<ThemeMode>("light");
  const label = computed(() => getThemeToggleLabel(theme.value));
  const isLight = computed(() => theme.value === "light");
  let controller: ThemeController | null = null;

  getScope().onActivate(() => {
    const nextController = createThemeController(
      createBrowserThemeEnvironment(),
      (next) => { theme.value = next; },
    );
    controller = nextController;
    nextController.start();

    return () => {
      controller = null;
      nextController.destroy();
    };
  });

  return (
    <button
      type="button"
      aria-label={label}
      class="inline-flex min-h-[2.75rem] min-w-[2.75rem] cursor-pointer items-center justify-center rounded-md group relative text-ink-soft hover:text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      on:click={() => { controller?.toggle(); }}
    >
      <Show when={isLight} fallback={() => <MoonIcon class="size-5" />}>
        {() => <SunIcon class="size-5" />}
      </Show>
      <span
        aria-hidden="true"
        class="tooltip pointer-events-none absolute left-[50%] top-full z-30 mt-1 -translate-x-[50%] whitespace-nowrap rounded-sm bg-ink px-hsp-xs py-hsp-2xs text-micro font-medium text-paper group-focus-visible:opacity-100 group-active:opacity-100"
      >
        {label}
      </span>
    </button>
  );
}

ThemeToggle.displayName = "ThemeToggle";
