import type { ComponentChildren } from "preact";

/** The responsive photo grid. auto-fill preserves empty slots on short final pages. */
export function PhotoGrid({ children }: { children: ComponentChildren }) {
  return <ul data-testid="photo-grid" data-gallery-grid="true" class="photo-grid">{children}</ul>;
}
