import { describe, expect, it } from "vitest";
import { listUserPhotoPage } from "../../lib/db/photos";
import type { Env } from "../../lib/env";

describe("user-scoped photo read model", () => {
  it("counts and queries only one owner with the trusted viewer favorite join", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            params = values;
            binds.push(values);
            return statement;
          },
          async first<T>() {
            expect(sql).toContain("WHERE user_id = ?");
            return { n: 25 } as T;
          },
          async all<T>() {
            expect(sql).toContain("WHERE p.user_id = ?");
            expect(sql).toContain("ORDER BY p.created_at DESC, p.id DESC");
            expect(params).toEqual([7, 7, 24, 0]);
            return {
              results: [{
                id: 12,
                user_id: 7,
                title: "Owner photo",
                r2_key: "photos/12.jpg",
                thumb_key: null,
                width: 1200,
                height: 800,
                blurhash: null,
                is_favorited: 1,
              }] as T[],
            };
          },
        };
        return statement;
      },
    } as unknown as D1Database;

    const result = await listUserPhotoPage({ DB: db } as Env, 7, 1, 7);
    expect(result).toMatchObject({
      page: 1,
      pageSize: 24,
      totalItems: 25,
      totalPages: 2,
      hasNext: true,
      items: [{ id: 12, user_id: 7, title: "Owner photo", is_favorited: true }],
    });
    expect(binds).toEqual([[7], [7, 7, 24, 0]]);
  });
});
