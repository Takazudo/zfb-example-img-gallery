import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTagInput } from "../../lib/db/tags";

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
