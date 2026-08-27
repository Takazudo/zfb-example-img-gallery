"use client";

import { useEffect, useRef, useState } from "preact/hooks";
import {
  createBrowserGalleryPreferencesEnvironment,
  createGalleryPreferencesController,
  DEFAULT_GALLERY_PREFERENCES,
  GALLERY_LAYOUT_OPTIONS,
  THUMBNAIL_RATIO_OPTIONS,
  THUMBNAIL_WIDTH_OPTIONS,
  type GalleryLayoutMode,
  type GalleryPreferences,
  type GalleryPreferencesController,
  type ThumbnailRatio,
  type ThumbnailWidth,
} from "../lib/gallery-preferences";
import { SlidersHorizontalIcon } from "./icons";

const triggerClass = "group relative flex w-full min-h-12 cursor-pointer items-center gap-hsp-sm rounded-md px-hsp-sm text-small text-ink transition-colors hover:bg-surface-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-[2.75rem] md:w-[2.75rem] md:min-w-[2.75rem] md:justify-center md:px-0 md:text-ink-soft md:hover:text-ink";
const optionClass = "flex min-h-[2.75rem] cursor-pointer items-center gap-hsp-xs rounded-md px-hsp-xs text-small text-ink transition-colors hover:bg-surface-sunken";

const layoutControlVisibility = {
  uniform: { ratio: true, width: true },
  spotlight: { ratio: false, width: false },
  editorial: { ratio: false, width: false },
  justified: { ratio: false, width: false },
  masonry: { ratio: false, width: true },
} as const satisfies Record<GalleryLayoutMode, {
  ratio: boolean;
  width: boolean;
}>;

function getLayoutDescription(layout: GalleryLayoutMode): string {
  if (layout === "uniform") {
    return "Adjust thumbnail ratio and width below.";
  }
  if (layout === "masonry") {
    return "Masonry keeps each photo's original ratio. Adjust thumbnail width below; your saved ratio stays unchanged.";
  }
  return "This layout manages thumbnail geometry automatically. Your saved ratio and width stay unchanged.";
}

export function DisplaySettings() {
  const [hydrated, setHydrated] = useState(false);
  const [preferences, setPreferences] = useState<GalleryPreferences>({
    ...DEFAULT_GALLERY_PREFERENCES,
  });
  const controller = useRef<GalleryPreferencesController | null>(null);
  const dialog = useRef<HTMLDialogElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const nextController = createGalleryPreferencesController(
      createBrowserGalleryPreferencesEnvironment(),
      setPreferences,
    );
    controller.current = nextController;
    nextController.start();
    setHydrated(true);

    return () => {
      controller.current = null;
      nextController.destroy();
    };
  }, []);

  const openDialog = () => {
    const node = dialog.current;
    if (!node) return;
    returnFocus.current = trigger.current;
    try {
      if (!node.open) node.showModal();
    } catch {
      // Older or restricted hosts may expose dialog without modal methods.
    }
  };

  const restoreFocus = () => {
    try {
      returnFocus.current?.focus();
    } catch {
      // The trigger may have left the document during a soft navigation.
    }
    if (typeof document !== "undefined" && document.activeElement !== returnFocus.current) {
      const menuTarget = document.querySelector<HTMLElement>('[popovertarget="primary-menu"]');
      menuTarget?.focus();
      if (document.activeElement !== menuTarget) {
        document.querySelector<HTMLElement>('[popovertarget="primary-menu"][aria-label="Menu"]')?.focus();
      }
    }
    returnFocus.current = null;
  };

  const selectRatio = (value: ThumbnailRatio) => {
    setPreferences(controller.current?.setRatio(value) ?? {
      ...preferences,
      thumbRatio: value,
    });
  };

  const selectWidth = (value: ThumbnailWidth) => {
    setPreferences(controller.current?.setWidth(value) ?? {
      ...preferences,
      thumbWidth: value,
    });
  };

  const selectLayout = (value: GalleryLayoutMode) => {
    setPreferences(controller.current?.setLayout(value) ?? {
      ...preferences,
      galleryLayout: value,
    });
  };

  const visibleControls = layoutControlVisibility[preferences.galleryLayout];

  return (
    <>
      {hydrated ? (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-label="Display settings"
          class={triggerClass}
          onClick={openDialog}
        >
          <SlidersHorizontalIcon class="size-5 text-ink-soft md:text-inherit" />
          <span class="md:sr-only">Display settings</span>
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-1/2 top-full z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-hsp-xs py-hsp-2xs text-micro font-medium text-paper opacity-0 transition-opacity delay-200 [.group:hover_&]:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100 hidden md:block"
          >
            Display settings
          </span>
        </button>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby="display-settings-title"
        aria-describedby="display-settings-description"
        class="m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100%-2rem))] overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-raised backdrop:bg-ink/40"
        onClose={restoreFocus}
      >
        <form method="dialog" class="flex max-h-[calc(100dvh-2rem)] flex-col">
          <div class="flex min-h-0 flex-1 flex-col gap-vsp-md overflow-y-auto overscroll-contain p-vsp-md">
            <div>
              <h2 id="display-settings-title" class="text-heading font-semibold">
                Display settings
              </h2>
              <p id="display-settings-description" class="mt-vsp-2xs text-small text-ink-soft">
                Choose how gallery thumbnails are displayed on this device.
              </p>
            </div>

            <fieldset aria-describedby="gallery-layout-description" class="flex flex-col gap-vsp-2xs">
              <legend class="mb-vsp-xs font-semibold">Gallery layout</legend>
              <p
                id="gallery-layout-description"
                aria-live="polite"
                class="mb-vsp-xs text-small text-ink-soft"
              >
                {getLayoutDescription(preferences.galleryLayout)}
              </p>
              {GALLERY_LAYOUT_OPTIONS.map((option) => (
                <label class={optionClass} key={option.value}>
                  <input
                    type="radio"
                    name="gallery-layout"
                    value={option.value}
                    checked={preferences.galleryLayout === option.value}
                    class="size-5 cursor-pointer accent-brand"
                    onChange={() => selectLayout(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>

            {visibleControls.ratio ? (
              <fieldset class="flex flex-col gap-vsp-2xs">
                <legend class="mb-vsp-xs font-semibold">Thumbnail ratio</legend>
                {THUMBNAIL_RATIO_OPTIONS.map((option) => (
                  <label class={optionClass} key={option.value}>
                    <input
                      type="radio"
                      name="thumbnail-ratio"
                      value={option.value}
                      checked={preferences.thumbRatio === option.value}
                      class="size-5 cursor-pointer accent-brand"
                      onChange={() => selectRatio(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}

            {visibleControls.width ? (
              <fieldset class="flex flex-col gap-vsp-2xs">
                <legend class="mb-vsp-xs font-semibold">Thumbnail width</legend>
                {THUMBNAIL_WIDTH_OPTIONS.map((option) => (
                  <label class={optionClass} key={option.value}>
                    <input
                      type="radio"
                      name="thumbnail-width"
                      value={option.value}
                      checked={preferences.thumbWidth === option.value}
                      class="size-5 cursor-pointer accent-brand"
                      onChange={() => selectWidth(option.value)}
                    />
                    <span>{option.label} <span class="text-ink-soft">({option.size})</span></span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>

          <div class="flex shrink-0 justify-end border-t border-line bg-surface px-hsp-md py-vsp-sm">
            <button
              type="submit"
              value="close"
              class="inline-flex min-h-[2.75rem] cursor-pointer items-center justify-center rounded-md bg-brand px-hsp-md text-small font-semibold text-on-brand transition-colors hover:bg-brand-strong"
            >
              Close
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

DisplaySettings.displayName = "DisplaySettings";
