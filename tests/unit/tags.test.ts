import { describe, expect, it } from "vitest";
import {
  normalizeTag,
  normalizeTagInput,
  normalizeTagName,
  resolveTagPage,
} from "../../lib/db/tags";

describe("normalizeTag", () => {
  it("trims, strips one hash, folds case/NFKC, and joins spaces", () => {
    expect(normalizeTag("  #Ｃａｆｅ  au   lait  ")).toBe("cafe-au-lait");
    expect(normalizeTag("  #Gallery  Wall  ")).toBe("gallery-wall");
    expect(normalizeTag("  ＃Cafe  ")).toBeNull();
  });

  it.each(["a/b", "a%b", "a?b", "a#b", "a\u0000b"])("rejects unsafe fragment %j", (raw) => {
    expect(normalizeTag(raw)).toBeNull();
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(normalizeTag("😀".repeat(32))).toBe("😀".repeat(32));
    expect(normalizeTag("😀".repeat(33))).toBeNull();
  });
});

describe("normalizeTagName", () => {
  it("is idempotent for an already-normalised stored name", () => {
    for (const name of ["cafe-au-lait", "東京", "😀😀"]) {
      expect(normalizeTagName(name)).toBe(name);
    }
  });

  it("round-trips encoded names through one router decode", () => {
    for (const name of ["cafe-au-lait", "東京", "naïve"])
      expect(normalizeTagName(decodeURIComponent(encodeURIComponent(name)))).toBe(name);
  });

  it.each(["a/b", "a%b", "a?b", "a#b", "a\u0000b", "a\u007fb", "a\u0080b"])(
    "rejects path delimiters and control characters %j",
    (raw) => expect(normalizeTagName(raw)).toBeNull(),
  );
});

describe("normalizeTagInput", () => {
  it("drops empty comma fragments without reporting an error", () => {
    expect(normalizeTagInput(" ,  , ")).toEqual({ tags: [], rejected: [] });
  });

  it("splits, canonicalises, dedupes, and preserves first occurrence order", () => {
    expect(normalizeTagInput("  #Travel,  travel , Ｃａｆｅ  au lait ")).toEqual({
      tags: ["travel", "cafe-au-lait"],
      rejected: [],
    });
  });

  it("reports fragments containing URL delimiters as rejected", () => {
    const result = normalizeTagInput("safe,a/b,a%b,a?b,a#b");
    expect(result.tags).toEqual(["safe"]);
    expect(result.rejected).toEqual(["a/b", "a%b", "a?b", "a#b"]);
  });

  it("accepts 32 code points and rejects 33", () => {
    const accepted = "😀".repeat(32);
    const rejected = "😀".repeat(33);
    expect(normalizeTagInput(`${accepted},${rejected}`)).toEqual({
      tags: [accepted],
      rejected: [rejected],
    });
  });

  it("keeps ten unique tags and reports the eleventh", () => {
    const result = normalizeTagInput("one,two,three,four,five,six,seven,eight,nine,ten,eleven");
    expect(result.tags).toHaveLength(10);
    expect(result.tags).toEqual(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
    expect(result.rejected).toEqual(["eleven"]);
  });
});

describe("resolveTagPage", () => {
  it.each([0, -3, "abc", "", "1.5", "1e999", "9007199254740992"])(
    "maps invalid page input %j to page 1",
    (raw) => expect(resolveTagPage(raw, 100).page).toBe(1),
  );

  it("clamps pages above the last page and keeps the 24-item boundary exact", () => {
    expect(resolveTagPage("999", 25)).toMatchObject({ page: 2, totalPages: 2, offset: 24 });
    expect(resolveTagPage("2", 24)).toMatchObject({ page: 1, totalPages: 1, offset: 0 });
    expect(resolveTagPage("2", 25)).toMatchObject({ page: 2, totalPages: 2, offset: 24 });
  });

  it("keeps an empty tag at page 1 of 1", () => {
    expect(resolveTagPage(undefined, 0)).toMatchObject({ page: 1, totalPages: 1, offset: 0 });
  });
});
