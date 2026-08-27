import { MAX_BATCH_SIZE } from "./infinite-gallery";
import { encodeGalleryLayoutClass } from "./gallery-layout-roles";
import type { FeedMetadata } from "./infinite-gallery";

/** The maximum time between the first and last card reveal in one batch. */
export const REVEAL_TOTAL_WINDOW_MS = 420;

/** The metadata required to describe the next loading-field batch. */
export type LoadingFieldMetadata = Pick<
  FeedMetadata,
  "page" | "pageSize" | "nextCount" | "terminal"
>;

export type LoadingFieldTile = {
  /** Compact class suffix consumed by the gallery layout selectors. */
  className: string;
  /** The intrinsic ratio used for the tile's `--a` custom property. */
  aspectRatio: number;
};

function tileCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_BATCH_SIZE);
}

function safeAspectRatio(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Return descriptors for the decorative cards reserved for the next batch.
 *
 * `page` is one-based, so the first card after page N starts at N * pageSize.
 * Keeping this offset metadata-derived is important for direct paginated URLs,
 * whose rendered-card count does not describe the absolute layout position.
 */
export function loadingFieldTiles(
  metadata: LoadingFieldMetadata,
  aspectRatio: number,
): LoadingFieldTile[] {
  if (metadata.terminal) return [];

  const count = tileCount(metadata.nextCount);
  if (count === 0) return [];

  const start = metadata.page * metadata.pageSize;
  const absoluteStart = Number.isSafeInteger(start) && start >= 0 ? start : 0;
  const ratio = safeAspectRatio(aspectRatio);
  return Array.from({ length: count }, (_, index) => ({
    className: encodeGalleryLayoutClass(absoluteStart + index),
    aspectRatio: ratio,
  }));
}

/**
 * Return a stable positive median for intrinsic card ratios.
 *
 * Invalid values are ignored; when no usable value remains, a square ratio is
 * the safe CSS fallback. The source array is never mutated.
 */
export function medianAspectRatio(values: readonly number[]): number {
  const finite = values
    .filter((value): value is number => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (finite.length === 0) return 1;

  const middle = Math.floor(finite.length / 2);
  if (finite.length % 2 === 1) return finite[middle]!;

  // Halving first avoids overflowing when both middle values are very large.
  const median = finite[middle - 1]! / 2 + finite[middle]! / 2;
  return Number.isFinite(median) && median > 0 ? median : 1;
}

/**
 * Spread card animation starts over one bounded window.
 *
 * A zero/invalid count has no cards to reveal. Counts above the established
 * batch size are retained here because this helper describes its input; the
 * feed metadata and incoming-card validation perform the batch-size bound.
 */
export function revealSchedule(count: number): number[] {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const denominator = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, index) => Math.min(
    REVEAL_TOTAL_WINDOW_MS,
    REVEAL_TOTAL_WINDOW_MS * index / denominator,
  ));
}
