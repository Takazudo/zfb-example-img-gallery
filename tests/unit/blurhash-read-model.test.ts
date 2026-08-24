import { describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { listPhotoPage } from "../../lib/db/photos";
import { listAuthorPhotoPage, listPhotosByAuthor } from "../../lib/db/authors";
import { listPhotosByTag, listTagPhotoPage } from "../../lib/db/tags";

describe("collection BlurHash read model", () => {
  it("selects blurhash in every global, author, and tag card query", async () => {
    const queries: string[] = [];
    const DB = {
      prepare(sql: string) {
        queries.push(sql.replace(/\s+/g, " ").trim().toLowerCase());
        const statement = {
          bind() { return statement; },
          async first<T>() { return { n: 0 } as T; },
          async all<T>() { return { results: [] as T[] }; },
        };
        return statement;
      },
    } as unknown as D1Database;
    const env = { DB } as Env;

    await listPhotoPage(env, 1);
    await listPhotosByAuthor(env, 1, 24, 0);
    await listAuthorPhotoPage(env, 1, 1);
    await listTagPhotoPage(env, 1, 1);
    await listPhotosByTag(env, 1, 24, 0);

    const cardQueries = queries.filter((sql) => sql.includes("limit ? offset ?"));
    expect(cardQueries).toHaveLength(5);
    expect(cardQueries.every((sql) => sql.includes("blurhash"))).toBe(true);
  });
});
