"use client";

import { useEffect } from "preact/hooks";
import { InfiniteGalleryController } from "../lib/infinite-gallery";

/** A zero-DOM island: the server grid and real next anchor remain outside Preact. */
export function InfiniteGalleryControllerIsland() {
  useEffect(() => {
    const controller = InfiniteGalleryController.mount();
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) controller?.restore();
    };
    addEventListener("pageshow", onPageShow);
    return () => {
      removeEventListener("pageshow", onPageShow);
      controller?.destroy();
    };
  }, []);

  return null;
}

InfiniteGalleryControllerIsland.displayName = "InfiniteGalleryControllerIsland";
