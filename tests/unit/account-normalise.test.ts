import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeUsername } from "../../lib/db/account";

describe("account normalisers", () => {
  it("trims and lowercases email addresses", () => {
    expect(normalizeEmail("  Alice.Example@Example.COM  ")).toBe("alice.example@example.com");
  });

  it("trims and lowercases usernames", () => {
    expect(normalizeUsername("  Alice_Example  ")).toBe("alice_example");
  });
});
