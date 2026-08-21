import type { Env } from "../env";
import type { SessionUser, User, UserCredentials } from "../types";

/** Lowercase and trim an email before storage or comparison. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Lowercase and trim a username before storage or comparison. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
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
export async function isUsernameTaken(env: Env, rawUsername: string, exceptUserId?: number): Promise<boolean> {
  const statement = exceptUserId === undefined
    ? env.DB.prepare("SELECT 1 AS found FROM users WHERE username = ? LIMIT 1").bind(normalizeUsername(rawUsername))
    : env.DB
      .prepare("SELECT 1 AS found FROM users WHERE username = ? AND id != ? LIMIT 1")
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

/** Rename a user after the caller has checked username uniqueness. */
export async function updateUsername(env: Env, userId: number, rawUsername: string): Promise<void> {
  await env.DB
    .prepare("UPDATE users SET username = ? WHERE id = ?")
    .bind(normalizeUsername(rawUsername), userId)
    .run();
}

/** Set or clear a user's avatar R2 key. */
export async function updateAvatarKey(env: Env, userId: number, avatarKey: string | null): Promise<void> {
  await env.DB
    .prepare("UPDATE users SET avatar_key = ? WHERE id = ?")
    .bind(avatarKey, userId)
    .run();
}

export interface AccountObjectKeys {
  avatarKey: string | null;
  photoKeys: string[];
  thumbKeys: string[];
  photoIds: number[];
}

interface AccountPhotoRow {
  id: number;
  r2_key: string;
  thumb_key: string | null;
}

/** Read every R2 object key owned by an account before any rows are deleted. */
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
export async function deleteAccountRows(env: Env, userId: number): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare("DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE user_id = ?)")
      .bind(userId),
    env.DB.prepare("DELETE FROM photos WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    env.DB.prepare("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM photo_tags)").bind(),
  ]);
}
