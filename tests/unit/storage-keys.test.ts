import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import {
  MAX_UPLOAD_BYTES, buildKey, contentLengthExceedsLimit, deleteObjects, isServableKey, parseKey,
} from "../../lib/storage";
import { createMockR2 } from "../helpers/mock-r2";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

describe("storage keys", () => {
  it.each([
    ["photos", "jpg"], ["thumbs", "png"], ["avatars", "webp"],
  ] as const)("round-trips %s/%s", (prefix, ext) => {
    const key = buildKey(prefix, UUID, ext);
    expect(parseKey(key)).toEqual({ prefix, uuid: UUID, ext });
  });

  it.each([
    "photos/../secret.jpg", "../etc/passwd", "/photos/x.jpg", "photos\\x.jpg",
    "derived/og/v1/1.jpg", `photos/${UUID.toUpperCase()}.jpg`, `photos/${UUID}.gif`, "",
  ])("rejects non-allowlisted key %s", (key) => expect(isServableKey(key)).toBe(false));
});

describe("contentLengthExceedsLimit", () => {
  it.each([
    [undefined, false], ["abc", false], ["-1", false], [String(MAX_UPLOAD_BYTES), false],
    [String(MAX_UPLOAD_BYTES + 1), true], ["9".repeat(400), true],
  ])("handles %s", (contentLength, expected) => {
    const headers = contentLength === undefined ? undefined : { "content-length": contentLength };
    expect(contentLengthExceedsLimit(new Request("https://example.test", { headers }))).toBe(expected);
  });
});

describe("deleteObjects", () => {
  it.each([[0, []], [1, [1]], [1000, [1000]], [1001, [1000, 1]]] as const)(
    "deletes %i keys in bounded batches",
    async (count, expected) => {
      const bucket = createMockR2();
      await deleteObjects(
        { BUCKET: bucket } as unknown as Env,
        Array.from({ length: count }, (_, i) => String(i)),
      );
      expect(bucket._deleteBatchSizes).toEqual(expected);
    },
  );
});
