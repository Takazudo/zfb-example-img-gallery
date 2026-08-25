import type { Env } from "../env";
import type { SessionUser, User, UserCredentials } from "../types";
import {
  chunkR2Keys,
  collectPhotoObjectKeys,
  deleteR2ObjectKeys,
} from "./photo-purge";

/** Lowercase and trim an email before storage or comparison. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Canonical username form used for storage, URLs, and comparisons. */
export function normalizeUsername(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

type DbSource = Env | D1Database;

function database(source: DbSource): D1Database {
  return "DB" in source ? source.DB : source;
}

/** Insert a user with already-hashed credentials and return its generated id. */
export async function createUser(
  env: Env,
  input: {
    username: string;
    email: string;
    passwordHash: string;
    passwordSalt: string;
  },
): Promise<number> {
  const result = await env.DB
    .prepare(
      `INSERT INTO users (username, email, password_hash, password_salt)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      normalizeUsername(input.username),
      normalizeEmail(input.email),
      input.passwordHash,
      input.passwordSalt,
    )
    .run();
  return result.meta.last_row_id;
}

/** Find login credentials by a normalised email address. */
export async function findUserCredentialsByEmail(
  env: Env,
  rawEmail: string,
): Promise<UserCredentials | null> {
  return env.DB
    .prepare(
      `SELECT id, username, email, avatar_key, created_at, password_hash, password_salt
         FROM users
        WHERE email = ?`,
    )
    .bind(normalizeEmail(rawEmail))
    .first<UserCredentials>();
}

/** Find a public user row by id. */
export async function findUserById(env: Env, id: number): Promise<User | null> {
  return env.DB
    .prepare("SELECT id, username, email, avatar_key, created_at FROM users WHERE id = ?")
    .bind(id)
    .first<User>();
}

/** Return whether a username is taken, excluding one optional existing user. */
export async function isUsernameTaken(
  source: DbSource,
  rawUsername: string,
  exceptUserId?: number,
): Promise<boolean> {
  const db = database(source);
  const statement = exceptUserId === undefined
    ? db.prepare("SELECT 1 AS found FROM users WHERE lower(username) = lower(?) LIMIT 1")
      .bind(normalizeUsername(rawUsername))
    : db
      .prepare("SELECT 1 AS found FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1")
      .bind(normalizeUsername(rawUsername), exceptUserId);
  return (await statement.first<{ found: number }>()) !== null;
}

/** Return whether an email is already registered. */
export async function isEmailTaken(env: Env, rawEmail: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT 1 AS found FROM users WHERE email = ? LIMIT 1")
    .bind(normalizeEmail(rawEmail))
    .first<{ found: number }>();
  return row !== null;
}

/** Insert an opaque server-side session with its ISO-8601 expiration timestamp. */
export async function insertSession(
  env: Env,
  sessionId: string,
  userId: number,
  expiresAt: string,
): Promise<void> {
  await env.DB
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, userId, expiresAt)
    .run();
}

/** Find a live session's minimal user identity and lazily sweep expired misses. */
export async function findSessionUser(env: Env, sessionId: string): Promise<SessionUser | null> {
  const row = await env.DB
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.avatar_key AS avatar_key
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?
          AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(sessionId)
    .first<SessionUser>();
  if (row !== null) return row;

  await env.DB
    .prepare(
      `DELETE FROM sessions
        WHERE id = ?
          AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(sessionId)
    .run();
  return null;
}

/** Delete one session by its opaque cookie value. */
export async function deleteSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

/** Invalidate every session belonging to a user. */
export async function deleteSessionsForUser(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/** Rename a user after the caller has checked username uniqueness.
 *
 * A pre-flight uniqueness query cannot close a concurrent-write race. D1
 * reports that race as a UNIQUE constraint error; expose it as false so the
 * route can return 409 instead of leaking a 500.
 */
export async function updateUsername(
  source: DbSource,
  userId: number,
  rawUsername: string,
): Promise<boolean> {
  try {
    await database(source)
      .prepare("UPDATE users SET username = ? WHERE id = ?")
      .bind(normalizeUsername(rawUsername), userId)
      .run();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint failed/i.test(message)) return false;
    throw error;
  }
}

/** Set a user's avatar key and return the previous key for post-update cleanup. */
export async function updateAvatarKey(
  source: DbSource,
  userId: number,
  avatarKey: string | null,
): Promise<string | null> {
  const db = database(source);
  const previous = await db
    .prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ avatar_key: string | null }>();
  await db
    .prepare("UPDATE users SET avatar_key = ? WHERE id = ?")
    .bind(avatarKey, userId)
    .run();
  return previous?.avatar_key ?? null;
}

export interface AccountUser {
  id: number;
  username: string;
  email: string;
  avatar_key: string | null;
  created_at: string;
}

/** Read the signed-in user's complete account row. */
export async function getAccount(source: DbSource, userId: number): Promise<AccountUser | null> {
  return database(source)
    .prepare("SELECT id, username, email, avatar_key, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first<AccountUser>();
}

export interface AccountObjectKeys {
  avatarKey: string | null;
  photoKeys: string[];
  thumbKeys: string[];
  photoIds: number[];
}

export interface AccountObjects {
  photoIds: number[];
  /** Photo blobs, every retained OG generation, and the avatar, deduplicated. */
  blobKeys: string[];
}

interface AccountPhotoRow {
  id: number;
  r2_key: string;
  thumb_key: string | null;
}

/** Read every R2 object key owned by an account before any rows are deleted. */
export async function collectAccountObjects(source: DbSource, userId: number): Promise<AccountObjects> {
  const db = database(source);
  const user = await db
    .prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ avatar_key: string | null }>();
  const photos = await db
    .prepare("SELECT id, r2_key, thumb_key FROM photos WHERE user_id = ?")
    .bind(userId)
    .all<AccountPhotoRow>();

  const blobKeys = new Set<string>();
  if (user?.avatar_key) blobKeys.add(user.avatar_key);
  for (const key of collectPhotoObjectKeys(photos.results)) blobKeys.add(key);

  return {
    photoIds: photos.results.map((photo) => photo.id),
    blobKeys: [...blobKeys],
  };
}

export async function collectAccountObjectKeys(env: Env, userId: number): Promise<AccountObjectKeys> {
  const user = await env.DB
    .prepare("SELECT avatar_key FROM users WHERE id = ?")
    .bind(userId)
    .first<{ avatar_key: string | null }>();
  const photos = await env.DB
    .prepare("SELECT id, r2_key, thumb_key FROM photos WHERE user_id = ?")
    .bind(userId)
    .all<AccountPhotoRow>();

  return {
    avatarKey: user?.avatar_key ?? null,
    photoKeys: photos.results.map((photo) => photo.r2_key),
    thumbKeys: photos.results.flatMap((photo) => photo.thumb_key === null ? [] : [photo.thumb_key]),
    photoIds: photos.results.map((photo) => photo.id),
  };
}

/** Delete all D1 rows for an account in one child-before-parent batch. */
export async function deleteAccountRows(source: DbSource, userId: number): Promise<void> {
  const db = database(source);
  await db.batch([
    db
      .prepare(
        `DELETE FROM favorites
          WHERE user_id = ?
             OR photo_id IN (SELECT id FROM photos WHERE user_id = ?)`,
      )
      .bind(userId, userId),
    db
      .prepare("DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE user_id = ?)")
      .bind(userId),
    db.prepare("DELETE FROM photos WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

/** Split an object-key list into R2-safe batches without reordering it. */
export function chunkKeys(keys: string[], size = 1000): string[][] {
  return chunkR2Keys(keys, size);
}

export type PurgeResult =
  | { ok: true }
  | { ok: false; reason: "r2-delete-failed" | "d1-delete-failed" };

/**
 * Delete R2 objects first. D1 rows are removed only after all R2 batches have
 * completed, so a failed/retried purge never leaves a row pointing at a
 * missing object and remains safe when a key was already deleted.
 */
export async function purgeAccount(env: Env, userId: number): Promise<PurgeResult> {
  let objects: AccountObjects;
  try {
    objects = await collectAccountObjects(env.DB, userId);
  } catch {
    return { ok: false, reason: "d1-delete-failed" };
  }

  try {
    await deleteR2ObjectKeys(env.BUCKET, objects.blobKeys);
  } catch {
    return { ok: false, reason: "r2-delete-failed" };
  }

  try {
    await deleteAccountRows(env.DB, userId);
  } catch {
    return { ok: false, reason: "d1-delete-failed" };
  }
  return { ok: true };
}
