import { describe, expect, it } from "vitest";
import { paginationItems } from "../../components/pagination";

describe("paginationItems", () => {
  const cases: Array<[string, number, number, Array<number | "ellipsis">]> = [
    ["first page", 1, 13, [1, 2, "ellipsis", 13]],
    ["middle page", 7, 13, [1, "ellipsis", 6, 7, 8, "ellipsis", 13]],
    ["last page", 13, 13, [1, "ellipsis", 12, 13]],
    ["three-page collection", 2, 3, [1, 2, 3]],
    ["one-page collection", 1, 1, []],
    ["empty collection", 1, 0, []],
    ["page below range", 0, 13, [1, 2, "ellipsis", 13]],
    ["page above range", 999, 13, [1, "ellipsis", 12, 13]],
    ["non-numeric page", Number.NaN, 13, [1, 2, "ellipsis", 13]],
  ];
  it.each(cases)("returns the reference window for %s", (_name, page, pageCount, expected) => {
    expect(paginationItems(page, pageCount)).toEqual(expected);
  });
});
