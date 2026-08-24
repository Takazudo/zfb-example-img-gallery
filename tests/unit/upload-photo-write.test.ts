import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import { insertPhoto, normalizeTags } from "../../lib/db/photo-write";

type BoundStatement = {
  sql: string;
  params: unknown[];
  bind: (...values: unknown[]) => BoundStatement;
  first: <T>() => Promise<T | null>;
};

function fakeD1(options: { lastRowId?: unknown; fallbackId?: unknown; fail?: boolean } = {}) {
  const prepared: BoundStatement[] = [];
  const db = {
    prepare(sql: string): BoundStatement {
      const statement = {} as BoundStatement;
      statement.sql = sql;
      statement.params = [];
      statement.bind = (...values: unknown[]) => {
        statement.params = values;
        return statement;
      };
      statement.first = async <T>() =>
        (options.fallbackId === undefined ? null : { id: options.fallbackId }) as T | null;
      prepared.push(statement);
      return statement;
    },
    async batch(statements: BoundStatement[]) {
      if (options.fail) throw new Error("D1 failed");
      return statements.map((statement, index) => ({
        success: true as const,
        results: [],
        meta: { changes: index === 0 ? 1 : 0, last_row_id: index === 0 ? options.lastRowId ?? 41 : 0 },
        statement,
      }));
    },
    _prepared: prepared,
  };
  return db;
}

describe("upload photo DB write", () => {
  it("normalises and dedupes tags in first-occurrence order", () => {
    expect(normalizeTags(" Synth , #Modular, synth ,, ENCLOSURE Deep ")).toEqual([
      "synth",
      "modular",
      "enclosure-deep",
    ]);
  });

  it("writes the photo, tag upserts and joins in one batch", async () => {
    const db = fakeD1({ lastRowId: 7 });
    const env = { DB: db } as unknown as Env;

    await expect(insertPhoto(env, {
      userId: 3,
      title: "A study",
      description: "Plain text",
      r2Key: "photos/uuid.png",
      contentType: "image/png",
      width: 800,
      height: 600,
      blurhash: "U4D]o#00fQ00~q00M{00M{~qRj~q",
      tags: ["synth", "modular"],
    })).resolves.toBe(7);

    expect(db._prepared).toHaveLength(5);
    expect(db._prepared[0].sql).toContain("thumb_key");
    expect(db._prepared[0].sql).toContain("NULL, ?, ?, ?, ?, datetime('now')");
    expect(db._prepared[0].params.at(-1)).toBe("U4D]o#00fQ00~q00M{00M{~qRj~q");
    expect(db._prepared[1].sql).toContain("INSERT INTO tags");
    expect(db._prepared[3].sql).toContain("INSERT INTO photo_tags");
    expect(db._prepared[3].params).toEqual(["photos/uuid.png", "synth"]);
  });

  it("falls back to the r2 key lookup when D1 does not return last_row_id", async () => {
    const db = fakeD1({ lastRowId: 0, fallbackId: "19" });
    const env = { DB: db } as unknown as Env;

    await expect(insertPhoto(env, {
      userId: 3,
      title: "Fallback",
      description: "",
      r2Key: "photos/uuid.jpg",
      contentType: "image/jpeg",
      width: 1,
      height: 1,
      blurhash: null,
      tags: [],
    })).resolves.toBe(19);
    expect(db._prepared[0].params.at(-1)).toBeNull();
    expect(db._prepared.at(-1)?.sql).toContain("SELECT id FROM photos WHERE r2_key");
  });

  it("throws when the batch and fallback cannot produce a photo id", async () => {
    const db = fakeD1({ lastRowId: 0 });
    const env = { DB: db } as unknown as Env;

    await expect(insertPhoto(env, {
      userId: 3,
      title: "No id",
      description: "",
      r2Key: "photos/uuid.webp",
      contentType: "image/webp",
      width: 1,
      height: 1,
      blurhash: null,
      tags: [],
    })).rejects.toThrow("did not return an id");
  });

  it("propagates a failed batch for the route to clean up", async () => {
    const db = fakeD1({ fail: true });
    const env = { DB: db } as unknown as Env;

    await expect(insertPhoto(env, {
      userId: 3,
      title: "Failure",
      description: "",
      r2Key: "photos/uuid.webp",
      contentType: "image/webp",
      width: 1,
      height: 1,
      blurhash: null,
      tags: [],
    })).rejects.toThrow("D1 failed");
  });
});

void vi;
