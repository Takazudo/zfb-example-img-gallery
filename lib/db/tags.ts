import type { Env } from "../env";
import type { Paged, PhotoCard, Tag, TagWithCount } from "../types";
import { PHOTO_PAGE_SIZE, resolvePage } from "./photos";

/** Maximum number of canonical tags that may be attached to one photo. */
export const MAX_TAGS_PER_PHOTO = 10;

/** Maximum number of Unicode code points in one canonical tag. */
export const TAG_MAX_CODEPOINTS = 32;

export interface TagParseResult {
  /** Accepted, normalised, deduped, capped at MAX_TAGS_PER_PHOTO. */
  tags: string[];
  /** Fragments rejected or dropped by the cap, for the upload form's error message. */
  rejected: string[];
}

/** Normalise one tag fragment, or null when it is empty or invalid. */
export function normalizeTag(raw: string): string | null {
  let tag = raw.trim();
  if (tag.startsWith("#")) tag = tag.slice(1);
  tag = tag.normalize("NFKC").toLowerCase().trim();
  tag = tag.replace(/\s+/g, "-");
  if (tag === "") return null;
  if (/[/%?#]/.test(tag)) return null;
  if (/[\u0000-\u001F\u007F]/.test(tag)) return null;
  if ([...tag].length > TAG_MAX_CODEPOINTS) return null;
  return tag;
}

/** Parse a comma-separated free-form tag field into validated canonical names. */
export function normalizeTagInput(input: string): TagParseResult {
  const tags: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const fragment of input.split(",")) {
    const raw = fragment.trim();
    const normalized = normalizeTag(raw);
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

/** Look up a tag by a URL segment after canonical normalisation. */
export async function getTagByName(env: Env, rawName: string): Promise<Tag | null> {
  const name = normalizeTag(rawName);
  if (name === null) return null;
  return env.DB
    .prepare("SELECT id, name FROM tags WHERE name = ?")
    .bind(name)
    .first<Tag>();
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
      `SELECT p.id, p.title, p.r2_key, p.thumb_key, p.width, p.height
         FROM photos p JOIN photo_tags pt ON pt.photo_id = p.id
        WHERE pt.tag_id = ?
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(tagId, pageMeta.pageSize, pageMeta.offset)
    .all<PhotoCard>();
  return { ...pageMeta, items: result.results };
}
