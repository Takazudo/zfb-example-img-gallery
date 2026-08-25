import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import {
  addFavorite,
  getFavoriteState,
  removeFavorite,
  setFavoriteState,
} from "../../lib/db/favorites";
import {
  normalizeFavoriteFlag,
  normalizePhotoCard,
  normalizeViewerId,
} from "../../lib/db/photos";

type Memory = {
  photoExists: boolean;
  memberships: Set<string>;
  photoId: number;
};

function memoryEnv(memory: Memory): Env {
  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async run() {
          if (normalized.startsWith("insert into favorites")) {
            if (memory.photoExists) memory.memberships.add(`${params[0]}:${params[1]}`);
          } else if (normalized.startsWith("delete from favorites")) {
            memory.memberships.delete(`${params[0]}:${params[1]}`);
          }
          return { success: true, meta: { changes: 1, last_row_id: 0 } };
        },
        async first<T>() {
          if (normalized.includes("from photos p")) {
            if (!memory.photoExists) return null;
            const userId = Number(params[0]);
            const favorited = memory.memberships.has(`${userId}:${memory.photoId}`);
            const count = [...memory.memberships].filter((key) => key.endsWith(`:${memory.photoId}`)).length;
            return {
              photo_id: memory.photoId,
              favorited: favorited ? 1 : 0,
              favorite_count: count,
            } as T;
          }
          throw new Error(`Unsupported unit fake query: ${sql}`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return { DB } as Env;
}

describe("viewer-aware read-model normalization", () => {
  it.each([
    [0, false],
    [1, true],
    ["0", false],
    ["1", true],
    [false, false],
    [true, true],
    [null, false],
  ] as const)("normalizes SQLite favorite flag %j", (raw, expected) => {
    expect(normalizeFavoriteFlag(raw)).toBe(expected);
  });

  it("accepts only positive safe viewer ids and makes anonymous state explicit", () => {
    expect(normalizeViewerId(7)).toBe(7);
    expect(normalizeViewerId(null)).toBeNull();
    expect(normalizeViewerId(undefined)).toBeNull();
    expect(normalizeViewerId(0)).toBeNull();
    expect(normalizeViewerId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it("projects owner identity and a normalized viewer flag without private fields", () => {
    expect(normalizePhotoCard({
      id: 3,
      user_id: 8,
      title: "Public photo",
      r2_key: "photos/3.webp",
      thumb_key: null,
      width: 1200,
      height: 800,
      blurhash: null,
      is_favorited: 1,
    })).toEqual({
      id: 3,
      user_id: 8,
      title: "Public photo",
      r2_key: "photos/3.webp",
      thumb_key: null,
      width: 1200,
      height: 800,
      blurhash: null,
      is_favorited: true,
    });
  });
});

describe("desired-state favorite mutations", () => {
  it("converges repeated add/remove requests and returns the authoritative count", async () => {
    const memory: Memory = { photoExists: true, memberships: new Set(), photoId: 9 };
    const env = memoryEnv(memory);

    await expect(addFavorite(env, 7, 9)).resolves.toEqual({ photoId: 9, favorited: true, favoriteCount: 1 });
    await expect(setFavoriteState(env, 7, 9, "favorited")).resolves.toEqual({ photoId: 9, favorited: true, favoriteCount: 1 });
    await expect(removeFavorite(env, 7, 9)).resolves.toEqual({ photoId: 9, favorited: false, favoriteCount: 0 });
    await expect(setFavoriteState(env, 7, 9, "unfavorited")).resolves.toEqual({ photoId: 9, favorited: false, favoriteCount: 0 });
    expect(memory.memberships).toHaveLength(0);
  });

  it("does not create a membership for a missing photo", async () => {
    const memory: Memory = { photoExists: false, memberships: new Set(), photoId: 404 };
    const env = memoryEnv(memory);
    await expect(setFavoriteState(env, 7, 404, "favorited")).resolves.toBeNull();
    expect(memory.memberships).toHaveLength(0);
    await expect(getFavoriteState(env, 7, 404)).resolves.toBeNull();
  });
});
