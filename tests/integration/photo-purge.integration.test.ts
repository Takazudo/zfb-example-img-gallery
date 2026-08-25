/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { purgeAccount } from "../../lib/db/account";
import { collectPhotoObjectKeys, purgePhotos } from "../../lib/db/photo-purge";
import initialMigration from "../../migrations/0001_init.sql?raw";
import favoritesMigration from "../../migrations/0002_favorites.sql?raw";

function splitMigration(sql: string): string[] {
  const queries: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        if (next === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === ";") {
      const query = sql.slice(start, index).trim();
      if (query) queries.push(query);
      start = index + 1;
    }
  }
  const remainder = sql.slice(start).trim();
  if (remainder) queries.push(remainder);
  return queries;
}

const migrations = [
  { name: "0001_init.sql", queries: splitMigration(initialMigration) },
  { name: "0002_favorites.sql", queries: splitMigration(favoritesMigration) },
];

const prefix = `purge-${crypto.randomUUID()}-`;
const userIds: number[] = [];
const photoIds: number[] = [];
const tagIds: number[] = [];

class FakeBucket {
  readonly keys = new Set<string>();
  readonly batches: string[][] = [];

  async delete(keys: string | string[]): Promise<void> {
    const batch = Array.isArray(keys) ? [...keys] : [keys];
    this.batches.push(batch);
    for (const key of batch) this.keys.delete(key);
  }
}

function db(): D1Database {
  return (env as unknown as Env).DB;
}

beforeAll(async () => {
  await applyD1Migrations(db(), migrations);
});

async function insertUser(label: string, avatarKey: string | null = null): Promise<number> {
  const result = await db()
    .prepare(
      `INSERT INTO users (username, email, password_hash, password_salt, avatar_key)
       VALUES (?, ?, 'hash', 'salt', ?)`,
    )
    .bind(`${prefix}${label}`, `${prefix}${label}@example.test`, avatarKey)
    .run();
  const id = Number(result.meta.last_row_id);
  userIds.push(id);
  return id;
}

async function insertPhoto(userId: number, label: string, thumbKey: string | null = null): Promise<number> {
  const result = await db()
    .prepare(
      `INSERT INTO photos (user_id, title, r2_key, thumb_key, content_type, width, height)
       VALUES (?, ?, ?, ?, 'image/jpeg', 1200, 800)`,
    )
    .bind(userId, label, `${prefix}${label}.jpg`, thumbKey)
    .run();
  const id = Number(result.meta.last_row_id);
  photoIds.push(id);
  return id;
}

async function insertTag(label: string): Promise<number> {
  const result = await db().prepare("INSERT INTO tags (name) VALUES (?)").bind(`${prefix}${label}`).run();
  const id = Number(result.meta.last_row_id);
  tagIds.push(id);
  return id;
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  return Number((await db().prepare(sql).bind(...params).first<{ n: number }>())?.n ?? 0);
}

afterEach(async () => {
  for (const userId of userIds) {
    await db().prepare("DELETE FROM favorites WHERE user_id = ?").bind(userId).run();
    await db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  }
  for (const photoId of photoIds) {
    await db().prepare("DELETE FROM favorites WHERE photo_id = ?").bind(photoId).run();
    await db().prepare("DELETE FROM photo_tags WHERE photo_id = ?").bind(photoId).run();
    await db().prepare("DELETE FROM photos WHERE id = ?").bind(photoId).run();
  }
  for (const userId of userIds) await db().prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  for (const tagId of tagIds) await db().prepare("DELETE FROM tags WHERE id = ?").bind(tagId).run();
  userIds.length = 0;
  photoIds.length = 0;
  tagIds.length = 0;
});

describe("photo purge against real D1", () => {
  it("atomically removes incoming favorites, tag links, and owned photo rows", async () => {
    const owner = await insertUser("owner");
    const other = await insertUser("other");
    const first = await insertPhoto(owner, "first", `${prefix}first-thumb.jpg`);
    const second = await insertPhoto(owner, "second");
    const untouched = await insertPhoto(other, "untouched");
    const tag = await insertTag("tag");
    await db().batch([
      db().prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(other, first),
      db().prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(owner, untouched),
      db().prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?)").bind(first, tag),
      db().prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?)").bind(second, tag),
    ]);
    const rows = [
      { id: first, r2_key: `${prefix}first.jpg`, thumb_key: `${prefix}first-thumb.jpg` },
      { id: second, r2_key: `${prefix}second.jpg`, thumb_key: null },
    ];
    const bucket = new FakeBucket();
    for (const key of collectPhotoObjectKeys(rows)) bucket.keys.add(key);

    await expect(purgePhotos(
      { DB: db(), BUCKET: bucket as unknown as R2Bucket }, owner, [first, second],
    )).resolves.toEqual({ ok: true, deletedIds: [first, second] });

    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id IN (?, ?)", first, second)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM photo_tags WHERE photo_id IN (?, ?)", first, second)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM favorites WHERE photo_id IN (?, ?)", first, second)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ? AND photo_id = ?", owner, untouched)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id = ?", untouched)).toBe(1);
    expect(bucket.keys.size).toBe(0);
  });

  it("rolls back the real D1 batch after R2 cleanup and succeeds on retry", async () => {
    const owner = await insertUser("rollback-owner");
    const other = await insertUser("rollback-other");
    const photo = await insertPhoto(owner, "rollback-photo");
    const tag = await insertTag("rollback-tag");
    await db().batch([
      db().prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(other, photo),
      db().prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?)").bind(photo, tag),
    ]);
    const bucket = new FakeBucket();
    const realDb = db();
    const failingDb = {
      prepare: (sql: string) => realDb.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => realDb.batch([
        ...statements,
        realDb.prepare("INSERT INTO purge_table_that_does_not_exist (id) VALUES (1)"),
      ]),
    } as unknown as D1Database;

    await expect(purgePhotos(
      { DB: failingDb, BUCKET: bucket as unknown as R2Bucket }, owner, [photo],
    )).resolves.toEqual({ ok: false, reason: "d1-delete-failed" });
    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id = ?", photo)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM photo_tags WHERE photo_id = ?", photo)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM favorites WHERE photo_id = ?", photo)).toBe(1);

    await expect(purgePhotos(
      { DB: realDb, BUCKET: bucket as unknown as R2Bucket }, owner, [photo],
    )).resolves.toEqual({ ok: true, deletedIds: [photo] });
    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id = ?", photo)).toBe(0);
  });

  it("account deletion removes outgoing and incoming favorites with sessions and objects", async () => {
    const avatar = `${prefix}avatar.jpg`;
    const owner = await insertUser("account-owner", avatar);
    const other = await insertUser("account-other");
    const owned = await insertPhoto(owner, "account-owned", `${prefix}account-thumb.jpg`);
    const otherPhoto = await insertPhoto(other, "account-other-photo");
    const tag = await insertTag("account-tag");
    await db().batch([
      db().prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(owner, otherPhoto),
      db().prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(other, owned),
      db().prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?)").bind(owned, tag),
      db().prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
        .bind(`${prefix}session`, owner, "2099-01-01T00:00:00.000Z"),
    ]);
    const bucket = new FakeBucket();
    const ownedKeys = collectPhotoObjectKeys([{
      id: owned,
      r2_key: `${prefix}account-owned.jpg`,
      thumb_key: `${prefix}account-thumb.jpg`,
    }]);
    for (const key of [avatar, ...ownedKeys]) bucket.keys.add(key);

    await expect(purgeAccount(
      { DB: db(), BUCKET: bucket as unknown as R2Bucket } as Env, owner,
    )).resolves.toEqual({ ok: true });

    expect(await count("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ? OR photo_id = ?", owner, owned)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM photo_tags WHERE photo_id = ?", owned)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id = ?", owned)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", owner)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?", owner)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM photos WHERE id = ?", otherPhoto)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM tags WHERE id = ?", tag)).toBe(1);
    expect(bucket.keys.size).toBe(0);
  });
});
