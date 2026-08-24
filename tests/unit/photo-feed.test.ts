import { describe, expect, it } from "vitest";
import {
  authorFeedScope,
  GLOBAL_FEED_SCOPE,
  remainingPhotoCount,
  tagFeedScope,
} from "../../components/photo-feed";

describe("shared photo feed contract", () => {
  it("keeps the next batch at 24 and reports an exact smaller remainder", () => {
    expect(remainingPhotoCount({ page: 1, pageSize: 24, totalItems: 49 })).toBe(24);
    expect(remainingPhotoCount({ page: 2, pageSize: 24, totalItems: 49 })).toBe(1);
    expect(remainingPhotoCount({ page: 3, pageSize: 24, totalItems: 49 })).toBe(0);
    expect(remainingPhotoCount({ page: 1, pageSize: 24, totalItems: 0 })).toBe(0);
    expect(remainingPhotoCount({ page: 1, pageSize: 48, totalItems: 100 })).toBe(24);
  });

  it("provides deterministic collection scopes for every route family", () => {
    expect(GLOBAL_FEED_SCOPE).toBe("global");
    expect(authorFeedScope(7)).toBe("author:7");
    expect(tagFeedScope(11)).toBe("tag:11");
  });
});
