/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { applyD1Migrations, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../lib/env";
import { listAuthorPhotoPage } from "../../lib/db/authors";
import { getPhotoDetail, listPhotoPage } from "../../lib/db/photos";
import { listTagPhotoPage } from "../../lib/db/tags";
import initialMigration from "../../migrations/0001_init.sql?raw";
import favoritesMigration from "../../migrations/0002_favorites.sql?raw";
import {
  addFavorite,
  countFavoritesForPhoto,
  countUserFavorites,
  getFavoriteState,
  listFavoritePage,
  removeFavorite,
} from "../../lib/db/favorites";

function workerEnv(): Env {
  return env as unknown as Env;
}

const prefix = `integration-favorites-${crypto.randomUUID()}-`;
const createdUserIds: number[] = [];
const createdPhotoIds: number[] = [];
const createdTagIds: number[] = [];

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
      if (query.length > 0) queries.push(query);
      start = index + 1;
    }
  }
  const remainder = sql.slice(start).trim();
  if (remainder.length > 0) queries.push(remainder);
  return queries;
}

const migrations = [
  { name: "0001_init.sql", queries: splitMigration(initialMigration) },
  { name: "0002_favorites.sql", queries: splitMigration(favoritesMigration) },
];

beforeAll(async () => {
  await applyD1Migrations(workerEnv().DB, migrations);
});

async function insertUser(label: string): Promise<number> {
  const db = workerEnv().DB;
  const result = await db
    .prepare(
      `INSERT INTO users (username, email, password_hash, password_salt)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(`${prefix}${label}`, `${prefix}${label}@example.test`, "hash", "salt")
    .run();
  const id = Number(result.meta.last_row_id);
  createdUserIds.push(id);
  return id;
}

async function insertPhoto(userId: number, index: number): Promise<number> {
  const key = `${prefix}photo-${index}.webp`;
  const result = await workerEnv().DB
    .prepare(
      `INSERT INTO photos (user_id, title, r2_key, content_type, width, height)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(userId, `Favorite photo ${index}`, key, "image/webp", 1200, 800)
    .run();
  const id = Number(result.meta.last_row_id);
  createdPhotoIds.push(id);
  return id;
}

async function insertTag(name: string): Promise<number> {
  const result = await workerEnv().DB
    .prepare("INSERT INTO tags (name) VALUES (?)")
    .bind(`${prefix}${name}`)
    .run();
  const id = Number(result.meta.last_row_id);
  createdTagIds.push(id);
  return id;
}

afterEach(async () => {
  const db = workerEnv().DB;
  // Delete children first because the legacy photos.user_id FK is intentionally
  // not part of this task's account-purge behavior.
  if (createdUserIds.length > 0 || createdPhotoIds.length > 0) {
    const favoriteTargets = [...createdUserIds, ...createdPhotoIds];
    const placeholders = favoriteTargets.map(() => "?").join(", ");
    await db
      .prepare(`DELETE FROM favorites WHERE user_id IN (${placeholders}) OR photo_id IN (${placeholders})`)
      .bind(...favoriteTargets, ...favoriteTargets)
      .run();
  }
  if (createdTagIds.length > 0) {
    const placeholders = createdTagIds.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM photo_tags WHERE tag_id IN (${placeholders})`).bind(...createdTagIds).run();
  }
  if (createdPhotoIds.length > 0) {
    const placeholders = createdPhotoIds.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`).bind(...createdPhotoIds).run();
  }
  if (createdUserIds.length > 0) {
    const placeholders = createdUserIds.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).bind(...createdUserIds).run();
  }
  if (createdTagIds.length > 0) {
    const placeholders = createdTagIds.map(() => "?").join(", ");
    await db.prepare(`DELETE FROM tags WHERE id IN (${placeholders})`).bind(...createdTagIds).run();
  }
  createdUserIds.length = 0;
  createdPhotoIds.length = 0;
  createdTagIds.length = 0;
});

describe("favorites D1 migration and runtime contract", () => {
  it("enforces composite uniqueness and both cascading foreign keys", async () => {
    const db = workerEnv().DB;
    const schema = await db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'favorites'")
      .first<{ sql: string }>();
    expect(schema?.sql).toContain("PRIMARY KEY (user_id, photo_id)");
    expect(schema?.sql).toContain("REFERENCES users(id) ON DELETE CASCADE");
    expect(schema?.sql).toContain("REFERENCES photos(id) ON DELETE CASCADE");
    const indexes = await db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'favorites'",
    ).all<{ name: string; sql: string }>();
    expect(indexes.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idx_favorites_photo" }),
      expect.objectContaining({
        name: "idx_favorites_user_created",
        sql: expect.stringContaining("(user_id, created_at DESC, photo_id DESC)"),
      }),
    ]));

    const foreignKeys = await db.prepare("PRAGMA foreign_key_list(favorites)").all<{
      table: string;
      from: string;
      on_delete: string;
    }>();
    expect(foreignKeys.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "users", from: "user_id", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "photos", from: "photo_id", on_delete: "CASCADE" }),
    ]));

    const user = await insertUser("owner");
    const other = await insertUser("other");
    const photo = await insertPhoto(other, 1);

    await expect(
      db.prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(user, photo).run(),
    ).resolves.toMatchObject({ success: true });
    await expect(
      db.prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(user, photo).run(),
    ).rejects.toThrow(/unique/i);
    await expect(
      db.prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(999999999, photo).run(),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      db.prepare("INSERT INTO favorites (user_id, photo_id) VALUES (?, ?)").bind(user, 999999999).run(),
    ).rejects.toThrow(/foreign key/i);

    await db.prepare("DELETE FROM users WHERE id = ?").bind(user).run();
    const afterUserDelete = await db
      .prepare("SELECT COUNT(*) AS n FROM favorites WHERE photo_id = ?")
      .bind(photo)
      .first<{ n: number }>();
    expect(afterUserDelete?.n).toBe(0);

    const secondUser = await insertUser("second");
    await addFavorite(workerEnv(), secondUser, photo);
    await db.prepare("DELETE FROM photos WHERE id = ?").bind(photo).run();
    const afterPhotoDelete = await db
      .prepare("SELECT COUNT(*) AS n FROM favorites WHERE photo_id = ?")
      .bind(photo)
      .first<{ n: number }>();
    expect(afterPhotoDelete?.n).toBe(0);
  });

  it("returns all-user counts, viewer membership, idempotent desired state, and deterministic favorite paging", async () => {
    const owner = await insertUser("owner");
    const other = await insertUser("other");
    const photos = await Promise.all(Array.from({ length: 25 }, (_, index) => insertPhoto(other, index)));
    const tag = await insertTag("read-model");
    await workerEnv().DB
      .prepare("INSERT INTO photo_tags (photo_id, tag_id) VALUES (?, ?)")
      .bind(photos[0], tag)
      .run();

    for (const photo of photos) {
      await expect(addFavorite(workerEnv(), owner, photo)).resolves.toMatchObject({
        photoId: photo,
        favorited: true,
      });
    }
    // A second user changes the public count but not owner's membership.
    await addFavorite(workerEnv(), other, photos[0]!);
    await expect(addFavorite(workerEnv(), owner, photos[0]!)).resolves.toMatchObject({
      photoId: photos[0],
      favorited: true,
      favoriteCount: 2,
    });
    await expect(getFavoriteState(workerEnv(), other, photos[0]!)).resolves.toEqual({
      photoId: photos[0],
      favorited: true,
      favoriteCount: 2,
    });
    await expect(getFavoriteState(workerEnv(), other, photos[1]!)).resolves.toEqual({
      photoId: photos[1],
      favorited: false,
      favoriteCount: 1,
    });
    await expect(addFavorite(workerEnv(), owner, 999999999)).resolves.toBeNull();
    expect(await countUserFavorites(workerEnv(), owner)).toBe(25);
    expect(await countFavoritesForPhoto(workerEnv(), photos[0]!)).toBe(2);

    const globalPage = await listPhotoPage(workerEnv(), 1, owner);
    expect(globalPage.items).toHaveLength(24);
    expect(globalPage.items[0]?.is_favorited).toBe(true);
    expect(globalPage.items[0]?.user_id).toBe(other);
    const anonymousGlobalPage = await listPhotoPage(workerEnv(), 1, null);
    expect(anonymousGlobalPage.items[0]?.is_favorited).toBe(false);
    const authorPage = await listAuthorPhotoPage(workerEnv(), other, 1, owner);
    expect(authorPage.items).toHaveLength(24);
    expect(authorPage.items.every((photo) => photo.user_id === other && photo.is_favorited)).toBe(true);
    const anonymousAuthorPage = await listAuthorPhotoPage(workerEnv(), other, 1, null);
    expect(anonymousAuthorPage.items.every((photo) => photo.is_favorited === false)).toBe(true);
    const tagPage = await listTagPhotoPage(workerEnv(), tag, 1, owner);
    expect(tagPage.items).toHaveLength(1);
    expect(tagPage.items[0]).toMatchObject({ id: photos[0], user_id: other, is_favorited: true });
    const anonymousTagPage = await listTagPhotoPage(workerEnv(), tag, 1, null);
    expect(anonymousTagPage.items[0]?.is_favorited).toBe(false);
    const detail = await getPhotoDetail(workerEnv(), photos[0], owner);
    expect(detail).toMatchObject({ favorite_count: 2, is_favorited: true });
    await expect(getPhotoDetail(workerEnv(), photos[0], null)).resolves.toMatchObject({
      favorite_count: 2,
      is_favorited: false,
    });

    // Make the tie-breaker observable and independent of upload timestamps.
    for (const [index, photo] of photos.entries()) {
      await workerEnv().DB
        .prepare("UPDATE favorites SET created_at = ? WHERE user_id = ? AND photo_id = ?")
        .bind(`2026-08-20T00:00:${String(index).padStart(2, "0")}.000Z`, owner, photo)
        .run();
    }
    await workerEnv().DB
      .prepare("UPDATE favorites SET created_at = ? WHERE user_id = ? AND photo_id = ?")
      .bind("2026-08-20T00:00:24.000Z", owner, photos[23])
      .run();

    const firstPage = await listFavoritePage(workerEnv(), owner, 1, null);
    expect(firstPage.pageSize).toBe(24);
    expect(firstPage.totalItems).toBe(25);
    expect(firstPage.totalPages).toBe(2);
    expect(firstPage.items).toHaveLength(24);
    expect(firstPage.items[0]?.id).toBe(photos[24]);
    expect(firstPage.items[1]?.id).toBe(photos[23]);
    expect(firstPage.items.every((photo) => photo.is_favorited === false)).toBe(true);

    const secondPage = await listFavoritePage(workerEnv(), owner, 2);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).toBe(photos[0]);
    expect(secondPage.items[0]?.is_favorited).toBe(true);

    await expect(removeFavorite(workerEnv(), owner, photos[0]!)).resolves.toEqual({
      photoId: photos[0],
      favorited: false,
      favoriteCount: 1,
    });
    await expect(removeFavorite(workerEnv(), owner, photos[0]!)).resolves.toEqual({
      photoId: photos[0],
      favorited: false,
      favoriteCount: 1,
    });
    expect(await countUserFavorites(workerEnv(), owner)).toBe(24);
  });
});
