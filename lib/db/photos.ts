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
export async function listPhotoPage(env: Env, rawPage: unknown): Promise<Paged<PhotoCard>> {
  const totalItems = await countPhotos(env);
  const pageMeta = resolvePage(rawPage, totalItems);
  const result = await env.DB
    .prepare(
      `SELECT id, title, r2_key, thumb_key, width, height, blurhash
         FROM photos
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCard>();

  return { ...pageMeta, items: result.results };
}

interface PhotoDetailRow extends Photo {
  author_id: number;
  author_username: string;
  author_avatar_key: string | null;
}

/** Read a photo, its author and its tags, or null for an invalid or unknown id. */
export async function getPhotoDetail(env: Env, rawId: unknown): Promise<PhotoDetail | null> {
  const id = parseId(rawId);
  if (id === null) return null;

  const row = await env.DB
    .prepare(
      `SELECT p.id, p.user_id, p.title, p.description, p.r2_key, p.thumb_key,
              p.content_type, p.width, p.height, p.blurhash, p.created_at,
              u.id AS author_id, u.username AS author_username, u.avatar_key AS author_avatar_key
         FROM photos p JOIN users u ON u.id = p.user_id
        WHERE p.id = ?`,
    )
    .bind(id)
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

  return { photo, author, tags: await listPhotoTags(env, id) };
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
