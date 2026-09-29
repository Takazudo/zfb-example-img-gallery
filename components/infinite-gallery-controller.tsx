"use client";

import { getScope, type Ref } from "@takazudo/zfb/zudo-react";
import { FavoriteController } from "../lib/favorite-controller";
import { gallerySnapshotStore } from "../lib/infinite-gallery";
import { InfiniteGalleryController, refreshActiveGalleryFeed } from "../lib/infinite-gallery";
import { ImagePlaceholderController } from "../lib/image-placeholder-controller";
import { PhotoActionsController } from "../lib/photo-actions-controller";

/** One layout island owns delegated gallery/favorite behavior and one toast. */
export function InfiniteGalleryControllerIsland() {
  const toastRef: Ref<HTMLDivElement> = { current: null };
  const dialogRef: Ref<HTMLDialogElement> = { current: null };
  const messageRef: Ref<HTMLParagraphElement> = { current: null };
  const errorRef: Ref<HTMLParagraphElement> = { current: null };
  const confirmRef: Ref<HTMLButtonElement> = { current: null };
  const cancelRef: Ref<HTMLButtonElement> = { current: null };
  const scope = getScope();

  scope.onActivate(() => {
    let disposed = false;
    let controller = InfiniteGalleryController.mount();
    const images = ImagePlaceholderController.mount();
    const refreshFeed = async () => {
      controller?.destroy();
      const refreshed = await refreshActiveGalleryFeed();
      // A router swap can dispose this activation while the refresh is pending;
      // mounting then would bind the controllers to the outgoing document.
      if (disposed || scope.abortSignal.aborted) return refreshed;
      controller = refreshed ? InfiniteGalleryController.mount() : null;
      images?.reconcile();
      return refreshed;
    };
    const favorites = toastRef.current ? FavoriteController.mount(
      toastRef.current,
      gallerySnapshotStore,
      refreshFeed,
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
          refreshFeed,
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
      disposed = true;
      removeEventListener("pageshow", onPageShow);
      controller?.destroy();
      images?.destroy();
      favorites?.destroy();
      actions?.destroy();
    };
  });

  return <>
    <div
      ref={toastRef}
      data-favorite-toast="true"
      data-visible="false"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      class="favorite-toast pointer-events-none fixed left-[50%] top-vsp-sm z-20 max-w-[min(90vw,30rem)] rounded-md bg-ink px-hsp-md py-vsp-xs text-center text-small font-semibold text-paper shadow-raised"
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
