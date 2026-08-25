import { describe, expect, it } from "vitest";
import {
  MAX_BULK_DELETE,
  chunkD1Values,
  collectPhotoObjectKeys,
  deleteR2ObjectKeys,
  parsePhotoIds,
  purgePhotos,
  resolveOwnedPhotos,
} from "../../lib/db/photo-purge";

type Photo = {
  id: number;
  user_id: number;
  r2_key: string;
  thumb_key: string | null;
};

type FakeStatement = {
  sql: string;
  params: unknown[];
  bind: (...params: unknown[]) => FakeStatement;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<never>;
};

class FakeDb {
  photos: Photo[] = [];
  favorites: Array<{ user_id: number; photo_id: number }> = [];
  photoTags: Array<{ photo_id: number; tag_id: number }> = [];
  readonly preparedParameterCounts: number[] = [];
  batchCalls = 0;
  failBatch = false;
  readonly DB: D1Database;

  constructor() {
    this.DB = {
      prepare: (sql: string) => this.statement(sql),
      batch: async (statements: FakeStatement[]) => {
        this.batchCalls += 1;
        if (this.failBatch) throw new Error("D1 batch failed");
        for (const statement of statements) this.apply(statement);
        return [];
      },
    } as unknown as D1Database;
  }

  private statement(sql: string, params: unknown[] = []): FakeStatement {
    return {
      sql,
      params,
      bind: (...values) => {
        this.preparedParameterCounts.push(values.length);
        return this.statement(sql, values);
      },
      all: async <T>() => {
        const userId = Number(params[0]);
        const ids = new Set(params.slice(1).map(Number));
        return {
          results: this.photos.filter((photo) => photo.user_id === userId && ids.has(photo.id)) as T[],
        };
      },
      run: async () => { throw new Error("purge writes must use batch"); },
    };
  }

  private apply(statement: FakeStatement): void {
    const normalized = statement.sql.replace(/\s+/g, " ").trim().toLowerCase();
    const owner = Number(statement.params[0]);
    const ids = new Set(statement.params.slice(1).map(Number));
    const ownedIds = new Set(this.photos
      .filter((photo) => photo.user_id === owner && ids.has(photo.id))
      .map((photo) => photo.id));
    if (normalized.startsWith("delete from favorites")) {
      this.favorites = this.favorites.filter((favorite) => !ownedIds.has(favorite.photo_id));
    } else if (normalized.startsWith("delete from photo_tags")) {
      this.photoTags = this.photoTags.filter((link) => !ownedIds.has(link.photo_id));
    } else if (normalized.startsWith("delete from photos")) {
      this.photos = this.photos.filter((photo) => !ownedIds.has(photo.id));
    }
  }
}

class FakeBucket {
  readonly keys = new Set<string>();
  readonly batches: string[][] = [];
  failCalls = new Set<number>();

  async delete(keys: string | string[]): Promise<void> {
    const batch = Array.isArray(keys) ? [...keys] : [keys];
    this.batches.push(batch);
    if (this.failCalls.has(this.batches.length)) throw new Error("R2 delete failed");
    for (const key of batch) this.keys.delete(key);
  }
}

function photo(id: number, userId = 1, thumb = true): Photo {
  return {
    id,
    user_id: userId,
    r2_key: `photos/${id}.jpg`,
    thumb_key: thumb ? `thumbs/${id}.jpg` : null,
  };
}

describe("photo purge input contract", () => {
  it("accepts positive safe integers and canonical digit strings, then deduplicates", () => {
    expect(parsePhotoIds([1, "2", 1, "2"])).toEqual({ ok: true, ids: [1, 2] });
  });

  it.each([
    { ids: [] }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] },
    { ids: [Number.MAX_SAFE_INTEGER + 1] }, { ids: [""] }, { ids: [" 1"] },
    { ids: ["01"] }, { ids: ["1.0"] }, { ids: ["1e2"] }, { ids: [null] },
  ] satisfies Array<{ ids: unknown[] }>)("rejects empty or invalid ids: $ids", ({ ids }) => {
    expect(parsePhotoIds(ids)).toEqual({ ok: false, reason: "invalid-or-unauthorized" });
  });

  it("accepts exactly 100 unique ids and rejects 101", () => {
    expect(parsePhotoIds(Array.from({ length: MAX_BULK_DELETE }, (_, index) => index + 1))).toMatchObject({ ok: true });
    expect(parsePhotoIds(Array.from({ length: MAX_BULK_DELETE + 1 }, (_, index) => index + 1))).toEqual({
      ok: false,
      reason: "invalid-or-unauthorized",
    });
  });

  it("chunks D1 values with reserved bindings below the 100-parameter ceiling", () => {
    const chunks = chunkD1Values(Array.from({ length: 199 }, (_, index) => index), 1);
    expect(chunks.map((chunk) => chunk.length)).toEqual([99, 99, 1]);
    expect(chunks.flat()).toHaveLength(199);
  });
});

describe("photo purge storage helpers", () => {
  it("collects original, thumbnail, and every retained OG generation without duplicates", () => {
    const keys = collectPhotoObjectKeys([
      photo(1),
      { ...photo(2, 1, false), r2_key: "photos/1.jpg" },
    ]);
    expect(keys).toEqual([
      "photos/1.jpg",
      "thumbs/1.jpg",
      "derived/og/v1/1.jpg",
      "derived/og/v2/1.jpg",
      "derived/og/v1/2.jpg",
      "derived/og/v2/2.jpg",
    ]);
  });

  it.each([
    [1000, [1000]],
    [1001, [1000, 1]],
  ] as const)("deletes %i R2 keys in safe batches", async (count, sizes) => {
    const bucket = new FakeBucket();
    await deleteR2ObjectKeys(
      bucket as unknown as R2Bucket,
      Array.from({ length: count }, (_, index) => `key-${index}`),
    );
    expect(bucket.batches.map((batch) => batch.length)).toEqual(sizes);
  });
});

describe("purgePhotos", () => {
  it("deletes single and multi-photo children, rows, and all object classes", async () => {
    const db = new FakeDb();
    db.photos = [photo(1), photo(2, 1, false), photo(3, 2)];
    db.favorites = [{ user_id: 2, photo_id: 1 }, { user_id: 1, photo_id: 3 }];
    db.photoTags = [{ photo_id: 1, tag_id: 7 }, { photo_id: 2, tag_id: 8 }, { photo_id: 3, tag_id: 9 }];
    const bucket = new FakeBucket();
    for (const key of collectPhotoObjectKeys(db.photos)) bucket.keys.add(key);

    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket },
      1,
      ["1", 2, 1],
    )).resolves.toEqual({ ok: true, deletedIds: [1, 2] });

    expect(db.batchCalls).toBe(1);
    expect(db.photos.map(({ id }) => id)).toEqual([3]);
    expect(db.photoTags).toEqual([{ photo_id: 3, tag_id: 9 }]);
    expect(db.favorites).toEqual([{ user_id: 1, photo_id: 3 }]);
    expect([...bucket.keys]).toEqual(collectPhotoObjectKeys([photo(3, 2)]));
  });

  it.each([
    ["foreign", [1, 3]],
    ["missing", [1, 999]],
  ] as const)("rejects a mixed %s batch before any mutation", async (_label, ids) => {
    const db = new FakeDb();
    db.photos = [photo(1), photo(3, 2)];
    const bucket = new FakeBucket();
    bucket.keys.add("photos/1.jpg");
    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket },
      1,
      ids,
    )).resolves.toEqual({ ok: false, reason: "invalid-or-unauthorized" });
    expect(bucket.batches).toEqual([]);
    expect(db.batchCalls).toBe(0);
    expect(db.photos).toHaveLength(2);
  });

  it("uses safe D1 parameter chunks for exactly 100 ids", async () => {
    const db = new FakeDb();
    db.photos = Array.from({ length: 100 }, (_, index) => photo(index + 1));
    await expect(resolveOwnedPhotos(db.DB, 1, db.photos.map(({ id }) => id))).resolves.toHaveLength(100);
    expect(db.preparedParameterCounts).toEqual([100, 2]);
  });

  it("stops before D1 on R2 failure and converges on retry", async () => {
    const db = new FakeDb();
    db.photos = [photo(1)];
    const bucket = new FakeBucket();
    for (const key of collectPhotoObjectKeys(db.photos)) bucket.keys.add(key);
    bucket.failCalls.add(1);

    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket }, 1, [1],
    )).resolves.toEqual({ ok: false, reason: "r2-delete-failed" });
    expect(db.batchCalls).toBe(0);
    expect(db.photos).toHaveLength(1);

    bucket.failCalls.clear();
    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket }, 1, [1],
    )).resolves.toEqual({ ok: true, deletedIds: [1] });
    expect(db.photos).toEqual([]);
  });

  it("represents a D1 batch failure safely and permits retry after storage cleanup", async () => {
    const db = new FakeDb();
    db.photos = [photo(1)];
    db.photoTags = [{ photo_id: 1, tag_id: 7 }];
    const bucket = new FakeBucket();
    db.failBatch = true;

    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket }, 1, [1],
    )).resolves.toEqual({ ok: false, reason: "d1-delete-failed" });
    expect(db.photos).toHaveLength(1);
    expect(db.photoTags).toHaveLength(1);

    db.failBatch = false;
    await expect(purgePhotos(
      { DB: db.DB, BUCKET: bucket as unknown as R2Bucket }, 1, [1],
    )).resolves.toEqual({ ok: true, deletedIds: [1] });
    expect(db.photos).toEqual([]);
  });
});
