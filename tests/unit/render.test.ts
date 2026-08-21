import { describe, expect, it } from "vitest";
import { redirect } from "../../lib/render";

describe("redirect", () => {
  it("issues a 303 so a refresh does not re-submit the form", () => {
    const res = redirect("/photos/1");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/photos/1");
  });

  it("merges extra headers", () => {
    expect(redirect("/", { "set-cookie": "sid=abc; Path=/" }).headers.get("set-cookie"))
      .toContain("sid=abc");
  });
});
