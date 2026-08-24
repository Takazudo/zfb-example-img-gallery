import type { Env } from "../env";
import type { Paged, PhotoCard, TagWithCount } from "../types";
import { PHOTO_PAGE_SIZE, resolvePage } from "./photos";

/** Maximum number of canonical tags that may be attached to one photo. */
export const MAX_TAGS_PER_PHOTO = 10;

/** Minimum number of Unicode code points in one canonical tag. */
export const TAG_MIN_CODEPOINTS = 1;

/** Maximum number of Unicode code points in one canonical tag. */
export const TAG_MAX_CODEPOINTS = 32;

/** URL delimiters and C0/C1 controls cannot safely inhabit a path segment. */
const FORBIDDEN_TAG_CHARS = /[\/%?#\u0000-\u001F\u007F-\u009F]/;

export type TagSummary = { id: number; name: string; photo_count: number };
export type TagRow = { id: number; name: string };
export type TaggedPhoto = {
  id: number;
  title: string;
  r2_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  blurhash: string | null;
  created_at: string;
  username: string;
};

export interface TagParseResult {
  /** Accepted, normalised, deduped, capped at MAX_TAGS_PER_PHOTO. */
  tags: string[];
  /** Fragments rejected or dropped by the cap, for the upload form's error message. */
  rejected: string[];
}

/** Normalise one tag fragment, or null when it is empty or invalid. */
export function normalizeTagName(raw: string): string | null {
  let tag = raw.trim();
  if (tag.startsWith("#")) tag = tag.slice(1);
  tag = tag.normalize("NFKC").toLowerCase().replace(/\s+/g, "-").trim();
  if (tag.length === 0) return null;
  if (FORBIDDEN_TAG_CHARS.test(tag)) return null;
  const codePoints = [...tag].length;
  if (codePoints < TAG_MIN_CODEPOINTS || codePoints > TAG_MAX_CODEPOINTS) return null;
  return tag;
}

/** Backwards-compatible name used by the upload form and foundation tests. */
export const normalizeTag = normalizeTagName;

/** Parse a comma-separated free-form tag field into validated canonical names. */
export function normalizeTagInput(input: string): TagParseResult {
  const tags: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const fragment of input.split(",")) {
    const raw = fragment.trim();
    const normalized = normalizeTagName(raw);
    if (normalized === null) {
      // Empty fragments are intentionally dropped; only invalid non-empty
      // fragments need to be called out in the upload form.
      if (raw !== "") rejected.push(raw);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (tags.length >= MAX_TAGS_PER_PHOTO) {
      rejected.push(normalized);
      continue;
    }
    tags.push(normalized);
  }

  return { tags, rejected };
}

/** Percent-encode a stored tag name for use as one URL segment. */
export function encodeTagSegment(name: string): string {
  return encodeURIComponent(name);
}

/** Decode a tag URL segment exactly once. */
export function decodeTagSegment(raw: string): string {
  return decodeURIComponent(raw);
}

/** List every tag attached to at least one photo, with counts sorted A-Z. */
export async function listAllTags(env: Env): Promise<TagWithCount[]> {
  const result = await env.DB
    .prepare(
      `SELECT t.id AS id, t.name AS name, COUNT(pt.photo_id) AS photo_count
         FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.name ASC`,
    )
    .all<TagWithCount>();
  return result.results;
}

/** Every tag in the table, including tags with no remaining photos. */
export async function listAllTagsWithCounts(env: Env): Promise<TagSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.id AS id, t.name AS name, COUNT(pt.photo_id) AS photo_count
       FROM tags t
       LEFT JOIN photo_tags pt ON pt.tag_id = t.id
      GROUP BY t.id, t.name
      ORDER BY photo_count DESC, t.name ASC`,
  ).all<TagSummary>();
  return results;
}

/** Look up a tag by its already-normalised name. */
export async function getTagByName(env: Env, name: string): Promise<TagRow | null> {
  return env.DB.prepare("SELECT id, name FROM tags WHERE name = ?").bind(name).first<TagRow>();
}

/** Count photos attached to one tag. */
export async function countPhotosByTag(env: Env, tagId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM photo_tags WHERE tag_id = ?")
    .bind(tagId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Read one clamped page of photos carrying a tag, newest first. */
export async function listTagPhotoPage(
  env: Env,
  tagId: number,
  rawPage: unknown,
): Promise<Paged<PhotoCard>> {
  const totalItems = await countPhotosByTag(env, tagId);
  const pageMeta = resolvePage(rawPage, totalItems, PHOTO_PAGE_SIZE);
  const result = await env.DB
    .prepare(
      `SELECT p.id, p.title, p.r2_key, p.thumb_key, p.width, p.height, p.blurhash
         FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id
        WHERE pt.tag_id = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(tagId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCard>();
  return { ...pageMeta, items: result.results };
}

/** One page of photos carrying this tag, newest first. */
export async function listPhotosByTag(
  env: Env,
  tagId: number,
  limit: number,
  offset: number,
): Promise<TaggedPhoto[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id AS id, p.title AS title, p.r2_key AS r2_key, p.thumb_key AS thumb_key,
            p.width AS width, p.height AS height, p.blurhash AS blurhash, p.created_at AS created_at,
            u.username AS username
       FROM photos p
       JOIN photo_tags pt ON pt.photo_id = p.id
       JOIN users u ON u.id = p.user_id
      WHERE pt.tag_id = ?
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(tagId, limit, offset)
    .all<TaggedPhoto>();
  return results;
}

/** Parse a tag page parameter with the stricter route contract. */
export function parseTagPage(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return 1;

  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** Resolve a tag page using the shared page-size and offset semantics. */
export function resolveTagPage(raw: unknown, totalItems: number) {
  return resolvePage(parseTagPage(raw), totalItems, PHOTO_PAGE_SIZE);
}
