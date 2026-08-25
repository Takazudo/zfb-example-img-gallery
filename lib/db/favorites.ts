import type { Env } from "../env";
import type { Paged, PhotoCard } from "../types";
import {
  normalizeFavoriteFlag,
  normalizePhotoCard,
  normalizeViewerId,
  PHOTO_PAGE_SIZE,
  resolvePage,
  type PhotoCardQueryRow,
} from "./photos";

/** The only accepted mutation states; callers must choose a desired state. */
export type FavoriteDesiredState = "favorited" | "unfavorited" | boolean;

/** Authoritative state returned after a read or desired-state mutation. */
export interface FavoriteState {
  photoId: number;
  favorited: boolean;
  favoriteCount: number;
}

/** Compatibility names for route callers that describe the same DTO as a status/result. */
export type FavoriteStatus = FavoriteState;
export type FavoriteMutationResult = FavoriteState;

interface FavoriteStateRow {
  photo_id: number;
  favorited: unknown;
  favorite_count: unknown;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function toFavoriteState(row: FavoriteStateRow): FavoriteState {
  return {
    photoId: row.photo_id,
    favorited: normalizeFavoriteFlag(row.favorited),
    favoriteCount: normalizeCount(row.favorite_count),
  };
}

/**
 * Read one photo's current membership for a trusted viewer and its count over
 * all users. A missing photo is represented by null, so it can never be
 * mistaken for an existing unfavorited photo by a mutation route.
 */
export async function getFavoriteState(
  env: Env,
  userId: number,
  photoId: number,
): Promise<FavoriteState | null> {
  const trustedUserId = normalizeViewerId(userId);
  if (trustedUserId === null || !validId(photoId)) return null;

  const row = await env.DB
    .prepare(
      `SELECT p.id AS photo_id,
              EXISTS (
                SELECT 1 FROM favorites f
                 WHERE f.user_id = ? AND f.photo_id = p.id
              ) AS favorited,
              (SELECT COUNT(*) FROM favorites f WHERE f.photo_id = p.id) AS favorite_count
         FROM photos p
        WHERE p.id = ?`,
    )
    .bind(trustedUserId, photoId)
    .first<FavoriteStateRow>();
  return row === null ? null : toFavoriteState(row);
}

/** Add one membership, ignoring an already-present composite-key row. */
export async function addFavorite(
  env: Env,
  userId: number,
  photoId: number,
): Promise<FavoriteState | null> {
  const trustedUserId = normalizeViewerId(userId);
  if (trustedUserId === null || !validId(photoId)) return null;

  // The SELECT guard makes a missing photo a no-op before the FK is checked.
  // The composite primary key makes repeated requests converge without a
  // read-before-write race.
  await env.DB
    .prepare(
      `INSERT INTO favorites (user_id, photo_id)
       SELECT ?, ?
        WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?)
       ON CONFLICT(user_id, photo_id) DO NOTHING`,
    )
    .bind(trustedUserId, photoId, photoId)
    .run();

  return getFavoriteState(env, trustedUserId, photoId);
}

/** Remove one membership, scoped to both the acting user and target photo. */
export async function removeFavorite(
  env: Env,
  userId: number,
  photoId: number,
): Promise<FavoriteState | null> {
  const trustedUserId = normalizeViewerId(userId);
  if (trustedUserId === null || !validId(photoId)) return null;

  await env.DB
    .prepare("DELETE FROM favorites WHERE user_id = ? AND photo_id = ?")
    .bind(trustedUserId, photoId)
    .run();
  return getFavoriteState(env, trustedUserId, photoId);
}

/** Set the requested state explicitly; this function never toggles blindly. */
export async function setFavoriteState(
  env: Env,
  userId: number,
  photoId: number,
  desired: FavoriteDesiredState,
): Promise<FavoriteState | null> {
  if (desired === "favorited" || desired === true) return addFavorite(env, userId, photoId);
  if (desired === "unfavorited" || desired === false) return removeFavorite(env, userId, photoId);
  throw new RangeError("favorite state must be favorited or unfavorited");
}

/** Count a user's current favorites. */
export async function countUserFavorites(env: Env, userId: number): Promise<number> {
  const trustedUserId = normalizeViewerId(userId);
  if (trustedUserId === null) return 0;
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?")
    .bind(trustedUserId)
    .first<{ n: unknown }>();
  return normalizeCount(row?.n);
}

/** Count all users' memberships for one existing photo id. */
export async function countFavoritesForPhoto(env: Env, photoId: number): Promise<number> {
  if (!validId(photoId)) return 0;
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM favorites WHERE photo_id = ?")
    .bind(photoId)
    .first<{ n: unknown }>();
  return normalizeCount(row?.n);
}

/**
 * Read one user's current favorites using the shared 24-item pagination
 * contract. The optional viewer id controls the card membership field; when
 * omitted, the collection owner is the viewer, while null is explicitly
 * anonymous.
 */
export async function listFavoritePage(
  env: Env,
  userId: number,
  rawPage: unknown,
  viewerId?: number | null,
): Promise<Paged<PhotoCard>> {
  const trustedUserId = normalizeViewerId(userId);
  const totalItems = await countUserFavorites(env, userId);
  const pageMeta = resolvePage(rawPage, totalItems, PHOTO_PAGE_SIZE);
  const trustedViewerId = normalizeViewerId(viewerId === undefined ? userId : viewerId);
  if (trustedUserId === null) return { ...pageMeta, items: [] };

  const result = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.r2_key, p.thumb_key, p.width, p.height, p.blurhash,
              CASE WHEN vf.photo_id IS NULL THEN 0 ELSE 1 END AS is_favorited
         FROM favorites f
         JOIN photos p ON p.id = f.photo_id
         LEFT JOIN favorites vf ON vf.photo_id = p.id AND vf.user_id = ?
        WHERE f.user_id = ?
        ORDER BY f.created_at DESC, f.photo_id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(trustedViewerId, trustedUserId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCardQueryRow>();

  return { ...pageMeta, items: result.results.map(normalizePhotoCard) };
}

// Names used by collection/mutation callers stay explicit while these aliases
// keep the narrow module convenient to discover from its domain noun.
export const getFavoriteStatus = getFavoriteState;
export const setFavorite = setFavoriteState;
export const listFavoritesPage = listFavoritePage;
export const listUserFavoritePage = listFavoritePage;
export const countFavoritesForUser = countUserFavorites;
