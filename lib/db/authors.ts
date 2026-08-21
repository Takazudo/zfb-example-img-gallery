import type { Env } from "../env";
import { normalizeUsername } from "./account";
import { PHOTO_PAGE_SIZE, resolvePage } from "./photos";
import type { AuthorSummary, Paged, PhotoCard } from "../types";

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

/** Look up an author by its case-insensitive URL username segment. */
export async function getAuthorByUsername(env: Env, rawUsername: string): Promise<AuthorSummary | null> {
  return env.DB
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.avatar_key AS avatar_key,
              (SELECT COUNT(*) FROM photos WHERE user_id = u.id) AS photo_count
         FROM users u
        WHERE u.username = ?`,
    )
    .bind(normalizeUsername(rawUsername))
    .first<AuthorSummary>();
}

/** Count photos belonging to one author. */
export async function countPhotosByAuthor(env: Env, userId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
      `SELECT id, title, r2_key, thumb_key, width, height
         FROM photos
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(userId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCard>();
  return { ...pageMeta, items: result.results };
}
