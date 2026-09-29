import type { Child } from "@takazudo/zfb/zudo-react";

/** The responsive photo grid. auto-fill preserves empty slots on short final pages. */
export function PhotoGrid({ children }: { children: Child }) {
  return <ul data-testid="photo-grid" data-gallery-grid="true" class="photo-grid">{children}</ul>;
}
