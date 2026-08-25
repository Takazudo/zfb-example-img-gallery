import { describe, expect, it } from "vitest";
import {
  isSafeRelativePath,
  loginPath,
  requestRelativePath,
  safeRelativePath,
} from "../../lib/navigation";

describe("safe relative navigation", () => {
  it.each(["/favorites", "/favorites/page/2?sort=recent", "/", "/photos/7#details"])(
    "accepts internal path %s",
    (value) => {
      expect(isSafeRelativePath(value)).toBe(true);
    },
  );

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\\\evil.example/",
    "javascript:alert(1)",
    "",
    "favorites",
  ])("rejects unsafe path %j", (value) => {
    expect(isSafeRelativePath(value)).toBe(false);
    expect(safeRelativePath(value, "/favorites")).toBe("/favorites");
  });

  it("builds a login URL only from the validated path", () => {
    expect(loginPath("/favorites/page/2")).toBe("/login?next=%2Ffavorites%2Fpage%2F2");
    expect(loginPath("https://evil.example")).toBe("/login");
    expect(requestRelativePath(new Request("https://gallery.example/favorites?page=2"))).toBe(
      "/favorites?page=2",
    );
  });
});
