"use client";

import { batch, computed, getScope, Show, signal, type Ref } from "@takazudo/zfb/zudo-react";
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

const triggerClass = "group relative flex w-full min-h-12 cursor-pointer items-center gap-hsp-sm rounded-md px-hsp-sm text-small text-ink transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand md:min-h-[2.75rem] md:w-[2.75rem] md:min-w-[2.75rem] md:justify-center md:px-0 md:text-ink-soft md:hover:text-ink";
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
  const hydrated = signal(false);
  const preferences = signal<GalleryPreferences>({
    ...DEFAULT_GALLERY_PREFERENCES,
  });
  // A radio's `checked` cannot be reactive (ZR_MODEL_UNSUPPORTED), so each group's
  // model owns its radios and mirrors `preferences`.
  const layoutModel = signal<string | null>(DEFAULT_GALLERY_PREFERENCES.galleryLayout);
  const ratioModel = signal<string | null>(DEFAULT_GALLERY_PREFERENCES.thumbRatio);
  const widthModel = signal<string | null>(DEFAULT_GALLERY_PREFERENCES.thumbWidth);
  const layoutDescription = computed(() => getLayoutDescription(preferences.value.galleryLayout));
  const showRatio = computed(() => layoutControlVisibility[preferences.value.galleryLayout].ratio);
  const showWidth = computed(() => layoutControlVisibility[preferences.value.galleryLayout].width);
  const dialog: Ref<HTMLDialogElement> = { current: null };
  const trigger: Ref<HTMLButtonElement> = { current: null };
  let controller: GalleryPreferencesController | null = null;
  let returnFocus: HTMLElement | null = null;

  const setPreferences = (next: GalleryPreferences) => {
    batch(() => {
      preferences.value = next;
      layoutModel.value = next.galleryLayout;
      ratioModel.value = next.thumbRatio;
      widthModel.value = next.thumbWidth;
    });
  };

  getScope().onActivate(() => {
    const nextController = createGalleryPreferencesController(
      createBrowserGalleryPreferencesEnvironment(),
      setPreferences,
    );
    controller = nextController;
    nextController.start();
    hydrated.value = true;

    return () => {
      controller = null;
      nextController.destroy();
    };
  });

  const openDialog = () => {
    const node = dialog.current;
    if (!node) return;
    returnFocus = trigger.current;
    try {
      if (!node.open) node.showModal();
    } catch {
      // Older or restricted hosts may expose dialog without modal methods.
    }
  };

  const restoreFocus = () => {
    try {
      returnFocus?.focus();
    } catch {
      // The trigger may have left the document during a soft navigation.
    }
    if (typeof document !== "undefined" && document.activeElement !== returnFocus) {
      const menuTarget = document.querySelector<HTMLElement>('[popovertarget="primary-menu"]');
      menuTarget?.focus();
      if (document.activeElement !== menuTarget) {
        document.querySelector<HTMLElement>('[popovertarget="primary-menu"][aria-label="Menu"]')?.focus();
      }
    }
    returnFocus = null;
  };

  const selectRatio = (value: ThumbnailRatio) => {
    setPreferences(controller?.setRatio(value) ?? {
      ...preferences.value,
      thumbRatio: value,
    });
  };

  const selectWidth = (value: ThumbnailWidth) => {
    setPreferences(controller?.setWidth(value) ?? {
      ...preferences.value,
      thumbWidth: value,
    });
  };

  const selectLayout = (value: GalleryLayoutMode) => {
    setPreferences(controller?.setLayout(value) ?? {
      ...preferences.value,
      galleryLayout: value,
    });
  };

  return (
    <>
      <Show when={hydrated}>{() => (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-label="Display settings"
          class={triggerClass}
          on:click={openDialog}
        >
          <SlidersHorizontalIcon class="display-settings-icon size-5" />
          <span class="md:sr-only">Display settings</span>
          <span
            aria-hidden="true"
            class="tooltip pointer-events-none absolute left-[50%] top-full z-30 mt-1 -translate-x-[50%] whitespace-nowrap rounded-sm bg-ink px-hsp-xs py-hsp-2xs text-micro font-medium text-paper group-focus-visible:opacity-100 group-active:opacity-100 hidden md:block"
          >
            Display settings
          </span>
        </button>
      )}</Show>
      <dialog
        ref={dialog}
        aria-labelledby="display-settings-title"
        aria-describedby="display-settings-description"
        class="m-auto max-h-[calc(100dvh_-_2rem)] w-[min(30rem,calc(100%_-_2rem))] overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-raised backdrop:bg-ink/40"
        on:close={restoreFocus}
      >
        <form method="dialog" class="flex max-h-[calc(100dvh_-_2rem)] flex-col">
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
                {layoutDescription}
              </p>
              {GALLERY_LAYOUT_OPTIONS.map((option) => (
                <label class={optionClass} key={option.value}>
                  <input
                    type="radio"
                    name="gallery-layout"
                    value={option.value}
                    modelValue={layoutModel}
                    class="size-5 cursor-pointer accent-brand"
                    on:change={() => selectLayout(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </fieldset>

            <Show when={showRatio}>{() => (
              <fieldset class="flex flex-col gap-vsp-2xs">
                <legend class="mb-vsp-xs font-semibold">Thumbnail ratio</legend>
                {THUMBNAIL_RATIO_OPTIONS.map((option) => (
                  <label class={optionClass} key={option.value}>
                    <input
                      type="radio"
                      name="thumbnail-ratio"
                      value={option.value}
                      modelValue={ratioModel}
                      class="size-5 cursor-pointer accent-brand"
                      on:change={() => selectRatio(option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </fieldset>
            )}</Show>

            <Show when={showWidth}>{() => (
              <fieldset class="flex flex-col gap-vsp-2xs">
                <legend class="mb-vsp-xs font-semibold">Thumbnail width</legend>
                {THUMBNAIL_WIDTH_OPTIONS.map((option) => (
                  <label class={optionClass} key={option.value}>
                    <input
                      type="radio"
                      name="thumbnail-width"
                      value={option.value}
                      modelValue={widthModel}
                      class="size-5 cursor-pointer accent-brand"
                      on:change={() => selectWidth(option.value)}
                    />
                    <span>{option.label} <span class="text-ink-soft">({option.size})</span></span>
                  </label>
                ))}
              </fieldset>
            )}</Show>
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
