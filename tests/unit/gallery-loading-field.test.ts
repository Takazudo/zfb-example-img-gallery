import { describe, expect, it } from "vitest";
import {
  loadingFieldTiles,
  medianAspectRatio,
  revealSchedule,
  REVEAL_TOTAL_WINDOW_MS,
  type LoadingFieldMetadata,
} from "../../lib/gallery-loading-field";
import { MAX_BATCH_SIZE } from "../../lib/infinite-gallery";

const metadata: LoadingFieldMetadata = {
  page: 1,
  pageSize: 24,
  nextCount: 24,
  terminal: false,
};

describe("gallery loading-field geometry", () => {
  it("returns one descriptor per pending item with the shared tile ratio", () => {
    expect(loadingFieldTiles({ ...metadata, nextCount: 3 }, 1.5)).toEqual([
      { className: "gs2", aspectRatio: 1.5 },
      { className: "gs3", aspectRatio: 1.5 },
      { className: "gs4", aspectRatio: 1.5 },
    ]);
  });

  it("derives direct-page role classes from the absolute metadata offset", () => {
    const directPage = loadingFieldTiles({ ...metadata, page: 2, nextCount: 3 }, 1);
    const appendedPage = loadingFieldTiles({ ...metadata, page: 1, nextCount: 3 }, 1);

    expect(directPage.map((tile) => tile.className)).toEqual(["gs4", "gs5", "gs6"]);
    expect(appendedPage.map((tile) => tile.className)).toEqual(["gs2", "gs3", "gs4"]);
  });

  it("returns no tiles for terminal feeds and clamps oversized batches", () => {
    expect(loadingFieldTiles({ ...metadata, terminal: true }, 1.5)).toEqual([]);
    expect(loadingFieldTiles({ ...metadata, nextCount: MAX_BATCH_SIZE + 10 }, 1)).toHaveLength(MAX_BATCH_SIZE);
  });

  it("uses a finite positive ratio even when the supplied estimate is invalid", () => {
    expect(loadingFieldTiles({ ...metadata, nextCount: 1 }, Number.NaN)).toEqual([
      { className: "gs2", aspectRatio: 1 },
    ]);
  });
});

describe("gallery loading-field aspect ratios", () => {
  it("handles empty and single-element input", () => {
    expect(medianAspectRatio([])).toBe(1);
    expect(medianAspectRatio([1.75])).toBe(1.75);
  });

  it("averages the two middle values for an even-length input without mutating it", () => {
    const values = [2, 1, 4, 3];
    expect(medianAspectRatio(values)).toBe(2.5);
    expect(values).toEqual([2, 1, 4, 3]);
  });

  it("ignores non-finite and unusable values and falls back safely", () => {
    expect(medianAspectRatio([Number.NaN, 4, Number.POSITIVE_INFINITY, 2])).toBe(3);
    expect(medianAspectRatio([Number.NaN, Number.NEGATIVE_INFINITY])).toBe(1);
    expect(Number.isFinite(medianAspectRatio([Number.NaN, Number.POSITIVE_INFINITY]))).toBe(true);
  });
});

describe("gallery loading-field reveal schedule", () => {
  it("starts at zero, spreads the whole batch, and stays within the window", () => {
    for (let count = 1; count <= MAX_BATCH_SIZE; count += 1) {
      const schedule = revealSchedule(count);
      expect(schedule).toHaveLength(count);
      expect(schedule[0]).toBe(0);
      if (count > 1) expect(schedule.at(-1)).toBe(REVEAL_TOTAL_WINDOW_MS);
      expect(schedule.every((delay, index) => (
        delay >= 0
        && delay <= REVEAL_TOTAL_WINDOW_MS
        && (index === 0 || delay >= schedule[index - 1]!)
      ))).toBe(true);
    }
  });

  it("has no delays when there are no cards", () => {
    expect(revealSchedule(0)).toEqual([]);
    expect(revealSchedule(-1)).toEqual([]);
  });
});
