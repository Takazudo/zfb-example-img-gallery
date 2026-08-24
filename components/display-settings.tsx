"use client";

import { useEffect, useRef, useState } from "preact/hooks";
import {
  createBrowserGalleryPreferencesEnvironment,
  createGalleryPreferencesController,
  DEFAULT_GALLERY_PREFERENCES,
  THUMBNAIL_RATIO_OPTIONS,
  THUMBNAIL_WIDTH_OPTIONS,
  type GalleryPreferences,
  type GalleryPreferencesController,
  type ThumbnailRatio,
  type ThumbnailWidth,
} from "../lib/gallery-preferences";

const triggerClass = "inline-flex min-h-[2.75rem] cursor-pointer items-center rounded-md px-hsp-xs text-small text-ink-soft transition-colors hover:bg-surface-sunken hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const optionClass = "flex min-h-[2.75rem] cursor-pointer items-center gap-hsp-xs rounded-md px-hsp-xs text-small text-ink transition-colors hover:bg-surface-sunken";

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

  return (
    <>
      {hydrated ? (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          class={triggerClass}
          onClick={openDialog}
        >
          Display settings
        </button>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby="display-settings-title"
        class="m-auto w-[min(30rem,calc(100%-2rem))] rounded-lg border border-line bg-surface p-0 text-ink shadow-raised backdrop:bg-ink/40"
        onClose={restoreFocus}
      >
        <form method="dialog" class="flex flex-col gap-vsp-md p-vsp-md">
          <div>
            <h2 id="display-settings-title" class="text-heading font-semibold">
              Display settings
            </h2>
            <p class="mt-vsp-2xs text-small text-ink-soft">
              Choose how gallery thumbnails are displayed on this device.
            </p>
          </div>

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

          <div class="flex justify-end">
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
