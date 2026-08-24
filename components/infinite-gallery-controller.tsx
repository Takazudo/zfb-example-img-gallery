"use client";

import { useEffect } from "preact/hooks";
import { InfiniteGalleryController } from "../lib/infinite-gallery";
import { ImagePlaceholderController } from "../lib/image-placeholder-controller";

/** A zero-DOM island: the server grid and real next anchor remain outside Preact. */
export function InfiniteGalleryControllerIsland() {
  useEffect(() => {
    const controller = InfiniteGalleryController.mount();
    const images = ImagePlaceholderController.mount();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller?.restore();
      if (event.persisted) images?.reconcile();
    };
    addEventListener("pageshow", onPageShow);
    return () => {
      removeEventListener("pageshow", onPageShow);
      controller?.destroy();
      images?.destroy();
    };
  }, []);

  return null;
}

InfiniteGalleryControllerIsland.displayName = "InfiniteGalleryControllerIsland";
