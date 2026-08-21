import type { ComponentChildren } from "preact";

/** The responsive photo grid. auto-fill preserves empty slots on short final pages. */
export function PhotoGrid({ children }: { children: ComponentChildren }) {
  return <ul data-testid="photo-grid" class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] gap-hsp-sm">{children}</ul>;
}
