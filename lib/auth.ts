/**
 * Auth core: PBKDF2 password hashing, opaque server-side sessions, and the
 * normalisation/validation rules the rest of the app depends on.
 *
 * Scope: register, login, logout, session lookup. Deliberately NOT here:
 * email verification, password reset, OAuth, "remember me", 2FA.
 *
 * CSRF stance: no CSRF token is issued. Every mutating route in this app is a
 * POST, and the `sid` cookie is `SameSite=Lax`, which browsers do not attach
 * to cross-site POST requests — that is the mitigation, and it is the reason
 * the attribute is not negotiable. Lax *does* send the cookie on top-level
 * cross-site GET navigations, which is why /logout is POST-only: a GET logout
 * is triggerable by a bare <img src>. A production system would add a
 * per-session token or an Origin-header check; that is out of scope for this
 * demo.
 */

import type { Env } from "./env";
import { readSessionId } from "./cookies";

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  avatar_key: string | null;
}

export const SESSION_TTL_SECONDS = 604_800;
export const PBKDF2_ITERATIONS = 100_000;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Usernames are a raw URL segment (/authors/{username}), so they must survive
// a URL with no percent-encoding: lowercase alnum plus - and _, alnum at both
// ends.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])$/;
const DUMMY_PASSWORD_SALT = "00000000000000000000000000000000";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The explicit ArrayBuffer generic is required by workers-types when this is
// passed as a Web Crypto BufferSource.
function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("Invalid hexadecimal value");
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** n random bytes, hex-encoded. */
export function randomHex(n: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(n)));
}

/** PBKDF2-SHA-256, 100k iterations, 256-bit digest, hex out. */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromHex(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

/** Compare two strings without early exits after their lengths match. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Render an epoch-milliseconds value in SQLite's `datetime('now')` format.
 * Required: expires_at is compared with a string `>` against datetime('now'),
 * and an ISO-8601 string compares greater than the SQLite form for the same
 * instant ("T" > " "), which would accept sessions that expired hours ago.
 */
export function sqliteTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export async function createSession(env: Env, userId: number): Promise<string> {
  const id = randomHex(32);
  const expiresAt = sqliteTimestamp(Date.now() + SESSION_TTL_SECONDS * 1000);
  await env.DB
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expiresAt)
    .run();
  return id;
}

export async function destroySession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

/** Resolve the signed-in user, or null. Expired rows are swept lazily on read
 * so stale sessions never accumulate unboundedly.
 */
export async function getSessionUser(env: Env, request: Request): Promise<SessionUser | null> {
  const sessionId = readSessionId(request);
  if (!sessionId) return null;

  const row = await env.DB
    .prepare(
      `SELECT users.id AS id, users.username AS username, users.email AS email,
              users.avatar_key AS avatar_key
         FROM sessions
         JOIN users ON users.id = sessions.user_id
        WHERE sessions.id = ? AND sessions.expires_at > datetime('now')`,
    )
    .bind(sessionId)
    .first<SessionUser>();

  if (!row) {
    await env.DB
      .prepare("DELETE FROM sessions WHERE id = ? AND expires_at <= datetime('now')")
      .bind(sessionId)
      .run();
    return null;
  }
  return row;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Return an error message, or null when the username is valid. */
export function validateUsername(username: string): string | null {
  const length = [...username].length;
  if (length < USERNAME_MIN || length > USERNAME_MAX) {
    return "Username must be 3–24 characters.";
  }
  if (!USERNAME_RE.test(username)) {
    return "Username may contain lowercase letters, digits, hyphen and underscore, and must start and end with a letter or digit.";
  }
  return null;
}

/** Return an error message, or null when the email is valid. */
export function validateEmail(email: string): string | null {
  return EMAIL_RE.test(email) ? null : "Enter a valid email address.";
}

/** Return an error message, or null when the password is valid. */
export function validatePassword(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return "Password must be at least 8 characters.";
  if (length > PASSWORD_MAX) return "Password must be at most 128 characters.";
  return null;
}

export class DuplicateUserError extends Error {
  constructor(readonly field: "email" | "username") {
    super(`${field} already registered`);
    this.name = "DuplicateUserError";
  }
}

export async function createUser(
  env: Env,
  input: { username: string; email: string; password: string },
): Promise<number> {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const clash = await env.DB
    .prepare("SELECT username, email FROM users WHERE username = ? OR email = ?")
    .bind(username, email)
    .first<{ username: string; email: string }>();
  if (clash) {
    throw new DuplicateUserError(clash.email === email ? "email" : "username");
  }

  const salt = randomHex(16);
  const hash = await hashPassword(input.password, salt);
  try {
    const result = await env.DB
      .prepare("INSERT INTO users (username, email, password_hash, password_salt) VALUES (?, ?, ?, ?)")
      .bind(username, email, hash, salt)
      .run();
    return Number(result.meta.last_row_id);
  } catch (err) {
    // D1 surfaces "UNIQUE constraint failed: users.email" — map it back to a
    // 409 instead of letting a race become a 500.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed")) {
      throw new DuplicateUserError(message.includes("users.email") ? "email" : "username");
    }
    throw err;
  }
}

export interface Credentials {
  id: number;
  password_hash: string;
  password_salt: string;
}

export async function findCredentialsByEmail(env: Env, email: string): Promise<Credentials | null> {
  return env.DB
    .prepare("SELECT id, password_hash, password_salt FROM users WHERE email = ?")
    .bind(normalizeEmail(email))
    .first<Credentials>();
}

/** Burn an equivalent PBKDF2 derivation when the email is unknown. */
export async function burnPasswordVerification(password: string): Promise<void> {
  await hashPassword(password, DUMMY_PASSWORD_SALT);
}
