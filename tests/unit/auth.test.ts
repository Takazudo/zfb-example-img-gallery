import { describe, expect, it } from "vitest";
import {
  hashPassword,
  normalizeEmail,
  normalizeUsername,
  PASSWORD_MAX,
  PASSWORD_MIN,
  randomHex,
  sqliteTimestamp,
  timingSafeEqual,
  USERNAME_MAX,
  USERNAME_MIN,
  validateEmail,
  validatePassword,
  validateUsername,
} from "../../lib/auth";

describe("auth hashing and tokens", () => {
  it("hashes the same password and salt deterministically", async () => {
    const salt = "00112233445566778899aabbccddeeff";
    const first = await hashPassword("correct horse battery staple", salt);
    expect(await hashPassword("correct horse battery staple", salt)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches an independently computed PBKDF2-SHA-256 vector", async () => {
    // Checked independently with node:crypto pbkdf2Sync (hex salt, SHA-256, 100000, 32).
    await expect(hashPassword("password", "00112233445566778899aabbccddeeff")).resolves.toBe(
      "fa97960c9c5fe8a3fb30d57bc7a6786f6b3504dfe3f9caaf886b28c7f16d072b",
    );
  });

  it("derives different hashes for different salts", async () => {
    const password = "correct horse battery staple";
    await expect(hashPassword(password, randomHex(16))).resolves.toHaveLength(64);
    const first = await hashPassword(password, "00112233445566778899aabbccddeeff");
    const second = await hashPassword(password, "ffeeddccbbaa99887766554433221100");
    expect(second).not.toBe(first);
  });

  it("uses cryptographically random 32-byte session-id material", () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unequal lengths before comparing characters", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });
});

describe("auth normalisation and validation", () => {
  it("trims and lowercases lookup values", () => {
    expect(normalizeEmail("  Alice@Example.COM  ")).toBe("alice@example.com");
    expect(normalizeUsername("  Takazudo_42  ")).toBe("takazudo_42");
  });

  it("validates URL-safe usernames", () => {
    expect(validateUsername("ab")).toBe("Username must be 3–24 characters.");
    expect(validateUsername("a".repeat(USERNAME_MAX + 1))).toBe("Username must be 3–24 characters.");
    expect(validateUsername("-alice")).toContain("must start and end");
    expect(validateUsername("alice-")).toContain("must start and end");
    expect(validateUsername("alice.example")).toContain("lowercase letters");
    expect(validateUsername("alice_42")).toBeNull();
    expect(validateUsername("a".repeat(USERNAME_MIN))).toBeNull();
  });

  it("validates email shape", () => {
    expect(validateEmail("person@example.com")).toBeNull();
    expect(validateEmail("not-an-email")).toBe("Enter a valid email address.");
  });

  it("validates password bounds by code point", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN - 1))).toBe("Password must be at least 8 characters.");
    expect(validatePassword("a".repeat(PASSWORD_MAX + 1))).toBe("Password must be at most 128 characters.");
    expect(validatePassword("pässword")).toBeNull();
  });
});

describe("SQLite timestamp format", () => {
  it("uses the space-separated second precision form", () => {
    expect(sqliteTimestamp(Date.parse("2026-08-21T20:00:00.999Z"))).toBe("2026-08-21 20:00:00");
  });
});
