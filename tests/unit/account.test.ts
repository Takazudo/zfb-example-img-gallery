import { describe, expect, it } from "vitest";
import { validateUsername } from "../../lib/auth";
import {
  chunkKeys,
  normalizeUsername,
} from "../../lib/db/account";

describe("account username rules", () => {
  it("normalises trim, NFKC, and case before storage", () => {
    expect(normalizeUsername("  Ａlice＿Example  ")).toBe("alice_example");
    expect(normalizeUsername("  BOB-7  ")).toBe("bob-7");
  });

  it("uses the shared 3–24 code-point ASCII username bounds", () => {
    expect(validateUsername("abc")).toBeNull();
    expect(validateUsername("ab")).toContain("3");
    expect(validateUsername("a".repeat(25))).toContain("24");
    expect(validateUsername("-abc")).toContain("must start and end");
    expect(validateUsername("abc!def")).toContain("lowercase letters");
    expect(validateUsername("abc😀")).toContain("lowercase letters");
  });
});

describe("chunkKeys", () => {
  it.each([0, 1, 1000, 1001, 2500])("preserves every key at %i keys", (count) => {
    const keys = Array.from({ length: count }, (_, index) => `key-${index}`);
    const chunks = chunkKeys(keys);
    expect(chunks.flat()).toEqual(keys);
    expect(new Set(chunks.flat()).size).toBe(count);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
  });

  it("rejects a non-positive batch size", () => {
    expect(() => chunkKeys(["key"], 0)).toThrow(RangeError);
  });
});
