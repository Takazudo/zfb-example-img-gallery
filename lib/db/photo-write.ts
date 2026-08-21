import type { Env } from "../env";
import { normalizeTag } from "./tags";

export type NewPhotoInput = {
  userId: number;
  title: string;
  description: string;
  r2Key: string;
  contentType: string;
  width: number;
  height: number;
  tags: string[];
};

/**
 * Canonicalise a comma-separated tag field while preserving first occurrence
 * order. Validation (unsafe characters, length and the ten-tag limit) belongs
 * to `normalizeTagInput`, which the upload route uses before writing.
 */
export function normalizeTags(raw: string): string[] {
  const tags: string[] = [];
  for (const part of raw.split(",")) {
    const tag = normalizeTag(part);
    if (tag === null || tags.includes(tag)) continue;
    tags.push(tag);
  }
  return tags;
}

/** Return a positive integer id, or null for an unusable D1 value. */
function positiveId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Insert a photo and its tags as one atomic D1 batch. */
export async function insertPhoto(env: Env, input: NewPhotoInput): Promise<number> {
  const statements = [
    env.DB
      .prepare(
        `INSERT INTO photos (user_id, title, description, r2_key, thumb_key,
                             content_type, width, height, blurhash, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, datetime('now'))`,
      )
      .bind(
        input.userId,
        input.title,
        input.description,
        input.r2Key,
        input.contentType,
        input.width,
        input.height,
      ),
    ...input.tags.map((name) =>
      env.DB
        .prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING")
        .bind(name),
    ),
    ...input.tags.map((name) =>
      env.DB
        .prepare(
          `INSERT INTO photo_tags (photo_id, tag_id)
           SELECT (SELECT id FROM photos WHERE r2_key = ?1), id FROM tags WHERE name = ?2
           ON CONFLICT(photo_id, tag_id) DO NOTHING`,
        )
        .bind(input.r2Key, name),
    ),
  ];

  const results = await env.DB.batch(statements);
  const id = positiveId(results[0]?.meta.last_row_id);
  if (id !== null) return id;

  const row = await env.DB
    .prepare("SELECT id FROM photos WHERE r2_key = ?")
    .bind(input.r2Key)
    .first<{ id: number | string }>();
  const fallbackId = positiveId(row?.id);
  if (fallbackId !== null) return fallbackId;
  throw new Error("photo insert did not return an id");
}
