import { describe, expect, it } from "vitest";
import { parsePageParam } from "../../pages/page/[page]";

describe("parsePageParam", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["47", 47],
    [undefined, 1],
    ["", 1],
    ["abc", 1],
    ["3abc", 1],
    ["1.5", 1],
    ["-3", 1],
    ["+2", 1],
    [" 2 ", 1],
    ["0", 1],
    ["000", 1],
    ["99999999999999999999", Number.MAX_SAFE_INTEGER],
  ] as const)("parses %j as %j", (raw, expected) => {
    expect(parsePageParam(raw)).toBe(expected);
  });
});
