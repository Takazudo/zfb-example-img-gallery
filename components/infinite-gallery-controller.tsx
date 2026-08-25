"use client";

import { useEffect, useRef } from "preact/hooks";
import { FavoriteController } from "../lib/favorite-controller";
import { gallerySnapshotStore } from "../lib/infinite-gallery";
import { InfiniteGalleryController, refreshActiveGalleryFeed } from "../lib/infinite-gallery";
import { ImagePlaceholderController } from "../lib/image-placeholder-controller";

/** One layout island owns delegated gallery/favorite behavior and one toast. */
export function InfiniteGalleryControllerIsland() {
  const toastRef = useRef<HTMLDivElement>(null);
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
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller?.restore();
      if (event.persisted) images?.reconcile();
    };
    addEventListener("pageshow", onPageShow);
    return () => {
      removeEventListener("pageshow", onPageShow);
      controller?.destroy();
      images?.destroy();
      favorites?.destroy();
    };
  }, []);

  return (
    <div
      ref={toastRef}
      data-favorite-toast="true"
      data-visible="false"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      class="pointer-events-none fixed left-1/2 top-vsp-sm z-20 max-w-[min(90vw,30rem)] -translate-x-1/2 -translate-y-hsp-xs rounded-md bg-ink px-hsp-md py-vsp-xs text-center text-small font-semibold text-paper opacity-0 shadow-raised transition-[opacity,transform] duration-200 ease-out data-[visible=true]:translate-y-0 data-[visible=true]:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-[opacity]"
    />
  );
}

InfiniteGalleryControllerIsland.displayName = "InfiniteGalleryControllerIsland";
