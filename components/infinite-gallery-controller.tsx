"use client";

import { useEffect, useRef } from "preact/hooks";
import { FavoriteController } from "../lib/favorite-controller";
import { gallerySnapshotStore } from "../lib/infinite-gallery";
import { InfiniteGalleryController, refreshActiveGalleryFeed } from "../lib/infinite-gallery";
import { ImagePlaceholderController } from "../lib/image-placeholder-controller";
import { PhotoActionsController } from "../lib/photo-actions-controller";

/** One layout island owns delegated gallery/favorite behavior and one toast. */
export function InfiniteGalleryControllerIsland() {
  const toastRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let controller = InfiniteGalleryController.mount();
    const images = ImagePlaceholderController.mount();
    const favorites = toastRef.current ? FavoriteController.mount(
      toastRef.current,
      gallerySnapshotStore,
      async () => {
        controller?.destroy();
        const refreshed = await refreshActiveGalleryFeed();
        controller = refreshed ? InfiniteGalleryController.mount() : null;
        images?.reconcile();
        return refreshed;
      },
    ) : null;
    const actions = dialogRef.current && messageRef.current && errorRef.current && confirmRef.current && cancelRef.current
      ? PhotoActionsController.mount({
          document,
          dialog: dialogRef.current,
          message: messageRef.current,
          error: errorRef.current,
          confirm: confirmRef.current,
          cancel: cancelRef.current,
          fetch: globalThis.fetch.bind(globalThis),
          invalidateSnapshots: () => gallerySnapshotStore.invalidateAll(),
          refreshFeed: async () => {
            controller?.destroy();
            const refreshed = await refreshActiveGalleryFeed();
            controller = refreshed ? InfiniteGalleryController.mount() : null;
            images?.reconcile();
            return refreshed;
          },
          navigate: (url) => location.assign(url),
          currentUrl: () => location.href,
        })
      : null;
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller?.restore();
      if (event.persisted) images?.reconcile();
      if (event.persisted) actions?.reconcile();
    };
    addEventListener("pageshow", onPageShow);
    return () => {
      removeEventListener("pageshow", onPageShow);
      controller?.destroy();
      images?.destroy();
      favorites?.destroy();
      actions?.destroy();
    };
  }, []);

  return <>
    <div
      ref={toastRef}
      data-favorite-toast="true"
      data-visible="false"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      class="pointer-events-none fixed left-1/2 top-vsp-sm z-20 max-w-[min(90vw,30rem)] -translate-x-1/2 -translate-y-hsp-xs rounded-md bg-ink px-hsp-md py-vsp-xs text-center text-small font-semibold text-paper opacity-0 shadow-raised transition-[opacity,transform] duration-200 ease-out data-[visible=true]:translate-y-0 data-[visible=true]:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-[opacity]"
    />
    <dialog ref={dialogRef} data-photo-delete-dialog="true" aria-labelledby="photo-delete-dialog-title" aria-describedby="photo-delete-dialog-message" class="photo-delete-dialog p-hsp-lg">
      <div class="flex flex-col gap-vsp-md">
        <div class="flex flex-col gap-vsp-xs">
          <p class="text-micro font-semibold uppercase tracking-widest text-danger">Permanent action</p>
          <h2 id="photo-delete-dialog-title" class="text-title font-semibold">Confirm deletion</h2>
          <p ref={messageRef} id="photo-delete-dialog-message" class="text-body" />
          <p ref={errorRef} data-photo-delete-error="true" role="alert" hidden class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger" />
        </div>
        <div class="flex flex-wrap justify-end gap-hsp-sm">
          <button ref={cancelRef} type="button" class="photo-toolbar-action">Cancel</button>
          <button ref={confirmRef} type="button" class="photo-toolbar-delete">Delete permanently</button>
        </div>
      </div>
    </dialog>
  </>;
}

InfiniteGalleryControllerIsland.displayName = "InfiniteGalleryControllerIsland";
