import { describe, expect, it } from "vitest";
import { AUTHOR_PAGE_SIZE, authorHref, resolvePageWindow } from "../../lib/db/authors";

describe("resolvePageWindow", () => {
  it.each([
    [undefined, 0, { page: 1, totalPages: 1, offset: 0 }],
    ["1", 24, { page: 1, totalPages: 1, offset: 0 }],
    ["2", 25, { page: 2, totalPages: 2, offset: 24 }],
    ["9999", 25, { page: 2, totalPages: 2, offset: 24 }],
    ["0", 25, { page: 1, totalPages: 2, offset: 0 }],
    ["-3", 25, { page: 1, totalPages: 2, offset: 0 }],
    ["abc", 25, { page: 1, totalPages: 2, offset: 0 }],
    ["", 25, { page: 1, totalPages: 2, offset: 0 }],
    ["99999999999999999999", 25, { page: 2, totalPages: 2, offset: 24 }],
  ] as const)("resolves %j for %j rows", (raw, total, expected) => {
    expect(resolvePageWindow(raw, total, AUTHOR_PAGE_SIZE)).toEqual(expected);
  });
});

describe("authorHref", () => {
  it("uses the bare author URL for page 1", () => {
    expect(authorHref("alice", 1)).toBe("/authors/alice");
  });

  it("uses a child route for later pages", () => {
    expect(authorHref("alice", 2)).toBe("/authors/alice/page/2");
  });

  it("percent-encodes one username segment", () => {
    expect(authorHref("Alice Smith", 1)).toBe("/authors/Alice%20Smith");
  });
});
