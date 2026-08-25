import type { Env } from "../env";
import type {
  PageMeta,
  Paged,
  Photo,
  PhotoCard,
  PhotoDetail,
  PhotoSitemapEntry,
  SessionUser,
  Tag,
} from "../types";

/** Page size for every grid in the app: top page, author detail, tag detail. */
export const PHOTO_PAGE_SIZE = 24;

/** A positive trusted viewer id, or the explicit anonymous state. */
export function normalizeViewerId(viewerId: unknown): number | null {
  return typeof viewerId === "number" && Number.isSafeInteger(viewerId) && viewerId > 0
    ? viewerId
    : null;
}

/** SQLite returns EXISTS/CASE expressions as 0/1 integers. */
export function normalizeFavoriteFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

export interface PhotoCardQueryRow {
  id: number;
  user_id: number;
  title: string;
  r2_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  blurhash: string | null;
  is_favorited: unknown;
}

/** Convert a raw D1 card row into one deterministic viewer-aware DTO. */
export function normalizePhotoCard(row: PhotoCardQueryRow): PhotoCard {
  return {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    r2_key: row.r2_key,
    thumb_key: row.thumb_key,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    is_favorited: normalizeFavoriteFlag(row.is_favorited),
  };
}

/** Raw route param -> positive safe integer id, or null. */
export function parseId(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Raw page input -> a fully clamped pagination state. */
export function resolvePage(raw: unknown, totalItems: number, pageSize = PHOTO_PAGE_SIZE): PageMeta {
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : PHOTO_PAGE_SIZE;
  const total = Number.isSafeInteger(totalItems) && totalItems > 0 ? totalItems : 0;
  const totalPages = Math.max(1, Math.ceil(total / size));

  let requested = 1;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    requested = Math.floor(raw);
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    requested = Number.isFinite(parsed) ? parsed : 1;
  }

  const page = Math.min(Math.max(1, requested), totalPages);
  return {
    page,
    pageSize: size,
    totalItems: total,
    totalPages,
    offset: (page - 1) * size,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

/** Count every photo in the gallery. */
export async function countPhotos(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read one clamped page of the global photo feed, newest first. */
export async function listPhotoPage(
  env: Env,
  rawPage: unknown,
  viewerId?: number | null,
): Promise<Paged<PhotoCard>> {
  const totalItems = await countPhotos(env);
  const pageMeta = resolvePage(rawPage, totalItems);
  const trustedViewerId = normalizeViewerId(viewerId);
  const result = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.r2_key, p.thumb_key, p.width, p.height, p.blurhash,
              CASE WHEN vf.photo_id IS NULL THEN 0 ELSE 1 END AS is_favorited
         FROM photos p
         LEFT JOIN favorites vf ON vf.photo_id = p.id AND vf.user_id = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(trustedViewerId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCardQueryRow>();

  return { ...pageMeta, items: result.results.map(normalizePhotoCard) };
}

/** Count the photos uploaded by one authenticated user. */
export async function countPhotosByUser(env: Env, userId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read one user's photo page, newest upload first, with viewer-aware cards. */
export async function listUserPhotoPage(
  env: Env,
  userId: number,
  rawPage: unknown,
  viewerId?: number | null,
): Promise<Paged<PhotoCard>> {
  const totalItems = await countPhotosByUser(env, userId);
  const pageMeta = resolvePage(rawPage, totalItems);
  const trustedViewerId = normalizeViewerId(viewerId);
  const result = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.r2_key, p.thumb_key, p.width, p.height, p.blurhash,
              CASE WHEN vf.photo_id IS NULL THEN 0 ELSE 1 END AS is_favorited
         FROM photos p
         LEFT JOIN favorites vf ON vf.photo_id = p.id AND vf.user_id = ?
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(trustedViewerId, userId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCardQueryRow>();

  return { ...pageMeta, items: result.results.map(normalizePhotoCard) };
}

interface PhotoDetailRow extends Photo {
  author_id: number;
  author_username: string;
  author_avatar_key: string | null;
  favorite_count?: number;
  is_favorited?: unknown;
}

/** Read a photo, its author and its tags, or null for an invalid or unknown id. */
export async function getPhotoDetail(
  env: Env,
  rawId: unknown,
  viewerId?: number | null,
): Promise<PhotoDetail | null> {
  const id = parseId(rawId);
  if (id === null) return null;
  const trustedViewerId = normalizeViewerId(viewerId);

  const row = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.description, p.r2_key, p.thumb_key,
              p.content_type, p.width, p.height, p.blurhash, p.created_at,
              u.id AS author_id, u.username AS author_username, u.avatar_key AS author_avatar_key,
              (SELECT COUNT(*) FROM favorites f WHERE f.photo_id = p.id) AS favorite_count,
              EXISTS (
                SELECT 1 FROM favorites vf
                 WHERE vf.photo_id = p.id AND vf.user_id = ?
              ) AS is_favorited
         FROM photos p JOIN users u ON u.id = p.user_id
        WHERE p.id = ?`,
    )
    .bind(trustedViewerId, id)
    .first<PhotoDetailRow>();
  if (row === null) return null;

  const photo: Photo = {
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description,
    r2_key: row.r2_key,
    thumb_key: row.thumb_key,
    content_type: row.content_type,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    created_at: row.created_at,
  };
  const author: SessionUser = {
    id: row.author_id,
    username: row.author_username,
    avatar_key: row.author_avatar_key,
  };

  return {
    photo,
    author,
    tags: await listPhotoTags(env, id),
    favorite_count: Number.isSafeInteger(Number(row.favorite_count)) && Number(row.favorite_count) >= 0
      ? Number(row.favorite_count)
      : 0,
    is_favorited: normalizeFavoriteFlag(row.is_favorited),
  };
}

/** Read the bare photo row used by image and social-card routes. */
export async function getPhotoRecord(env: Env, id: number): Promise<Photo | null> {
  return env.DB
    .prepare(
      `SELECT id, user_id, title, description, r2_key, thumb_key,
              content_type, width, height, blurhash, created_at
         FROM photos
        WHERE id = ?`,
    )
    .bind(id)
    .first<Photo>();
}

/** List a photo's tags alphabetically by canonical tag name. */
export async function listPhotoTags(env: Env, photoId: number): Promise<Tag[]> {
  const result = await env.DB
    .prepare(
      `SELECT t.id, t.name
         FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.photo_id = ?
        ORDER BY t.name`,
    )
    .bind(photoId)
    .all<Tag>();
  return result.results;
}

/** List every photo id and timestamp for sitemap generation, newest first. */
export async function listPhotosForSitemap(env: Env): Promise<PhotoSitemapEntry[]> {
  const result = await env.DB
    .prepare("SELECT id, created_at FROM photos ORDER BY created_at DESC, id DESC")
    .all<PhotoSitemapEntry>();
  return result.results;
}
