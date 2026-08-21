import { describe, expect, it } from "vitest";
import { parseId, resolvePage } from "../../lib/db/photos";

describe("resolvePage", () => {
  it("keeps an empty dataset as page 1 of 1", () => {
    expect(resolvePage(undefined, 0)).toEqual({
      page: 1,
      pageSize: 24,
      totalItems: 0,
      totalPages: 1,
      offset: 0,
      hasPrev: false,
      hasNext: false,
    });
  });

  it("uses exactly two pages for 48 items", () => {
    expect(resolvePage(2, 48)).toMatchObject({ page: 2, totalPages: 2, offset: 24, hasPrev: true, hasNext: false });
  });

  it.each([undefined, "", "0", "-2", "abc", "1.5", "1e3"])("clamps hostile input %j to page 1", (raw) => {
    expect(resolvePage(raw, 100).page).toBe(1);
  });

  it("accepts trimmed positive integer strings", () => {
    expect(resolvePage(" 3 ", 100)).toMatchObject({ page: 3, totalPages: 5, offset: 48 });
  });

  it("clamps an overflowing page number to the last page", () => {
    expect(resolvePage("99999999999999999999999", 100)).toMatchObject({
      page: 5,
      totalPages: 5,
      offset: 96,
      hasPrev: true,
      hasNext: false,
    });
  });
});

describe("parseId", () => {
  it.each(["", "0", "-1", "1.5", "12abc", "７", undefined])("rejects %j", (raw) => {
    expect(parseId(raw)).toBeNull();
  });

  it("accepts a positive ASCII integer", () => {
    expect(parseId("7")).toBe(7);
  });
});
