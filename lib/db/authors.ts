import type { Env } from "../env";
import { PHOTO_PAGE_SIZE, resolvePage } from "./photos";
import type { AuthorSummary, Paged, PhotoCard } from "../types";

export type { AuthorSummary } from "../types";

/** Number of photo tiles shown on one author page. */
export const AUTHOR_PAGE_SIZE = PHOTO_PAGE_SIZE;

export interface AuthorProfile {
  id: number;
  username: string;
  avatar_key: string | null;
  created_at: string;
}

export interface PageWindow {
  /** Clamped, 1-based page number. */
  page: number;
  /** At least one even when the collection is empty. */
  totalPages: number;
  offset: number;
}

/** List authors with at least one photo, most prolific first. */
export async function listAuthorsWithPhotos(env: Env): Promise<AuthorSummary[]> {
  const result = await env.DB
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.avatar_key AS avatar_key,
              COUNT(p.id) AS photo_count
         FROM users u JOIN photos p ON p.user_id = u.id
        GROUP BY u.id
       HAVING COUNT(p.id) > 0
        ORDER BY photo_count DESC, u.username ASC`,
    )
    .all<AuthorSummary>();
  return result.results;
}

/**
 * Resolve one author without changing the URL-decoded route parameter.
 * SQLite's default TEXT comparison is case-sensitive, so NOCASE keeps
 * /authors/Alice and /authors/alice on the same profile while preserving the
 * stored casing for the page heading and canonical URL.
 */
export async function getAuthorByUsername(env: Env, username: string): Promise<AuthorProfile | null> {
  return env.DB
    .prepare(
      `SELECT id, username, avatar_key, created_at
         FROM users
        WHERE username = ? COLLATE NOCASE
        LIMIT 1`,
    )
    .bind(username)
    .first<AuthorProfile>();
}

/** Count photos belonging to one author. */
export async function countPhotosByAuthor(env: Env, userId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read one author page after the caller has resolved its total count. */
export async function listPhotosByAuthor(
  env: Env,
  userId: number,
  limit: number,
  offset: number,
): Promise<PhotoCard[]> {
  const result = await env.DB
    .prepare(
      `SELECT id, title, r2_key, thumb_key, width, height, blurhash, created_at
         FROM photos
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<PhotoCard>();
  return result.results;
}

/** Resolve a one-based author page, clamping garbage and out-of-range input. */
export function resolvePageWindow(
  raw: string | undefined,
  total: number,
  pageSize: number,
): PageWindow {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const parsed = Number.parseInt(raw ?? "1", 10);
  // Keep finite overflow values so they clamp to the last page. A huge
  // decimal string is still a useful request for "the last page"; only a
  // parse failure should fall back to page 1.
  const requested = Number.isFinite(parsed) ? parsed : 1;
  const page = Math.min(Math.max(requested, 1), totalPages);
  return { page, totalPages, offset: (page - 1) * pageSize };
}

/** Page 1 uses the bare author URL; later pages use the child route. */
export function authorHref(username: string, page = 1): string {
  const base = `/authors/${encodeURIComponent(username)}`;
  return page <= 1 ? base : `${base}/page/${page}`;
}

/** Read one clamped page of an author's photos, newest first. */
export async function listAuthorPhotoPage(
  env: Env,
  userId: number,
  rawPage: unknown,
): Promise<Paged<PhotoCard>> {
  const totalItems = await countPhotosByAuthor(env, userId);
  const pageMeta = resolvePage(rawPage, totalItems, PHOTO_PAGE_SIZE);
  const result = await env.DB
    .prepare(
      `SELECT id, title, r2_key, thumb_key, width, height, blurhash
         FROM photos
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCard>();
  return { ...pageMeta, items: result.results };
}
