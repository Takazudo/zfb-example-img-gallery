import type { Env } from "../env";
import { ogObjectKeysForPhoto } from "../og";

/** Shared request ceiling for bulk photo deletion routes and controls. */
export const MAX_BULK_DELETE = 100;

/** D1 currently accepts at most 100 bound parameters per statement. */
export const MAX_D1_BOUND_PARAMETERS = 100;

/** R2's multi-object delete API accepts at most 1,000 keys per call. */
export const MAX_R2_DELETE_KEYS = 1000;

export type ParsedPhotoIds =
  | { ok: true; ids: number[] }
  | { ok: false; reason: "invalid-or-unauthorized" };

export type PhotoPurgeResult =
  | { ok: true; deletedIds: number[] }
  | { ok: false; reason: "invalid-or-unauthorized" | "r2-delete-failed" | "d1-delete-failed" };

export interface PurgePhotoRow {
  id: number;
  r2_key: string;
  thumb_key: string | null;
}

function parsePhotoId(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** Validate and deduplicate an untrusted list of photo ids without coercive parsing. */
export function parsePhotoIds(values: readonly unknown[]): ParsedPhotoIds {
  if (values.length === 0 || values.length > MAX_BULK_DELETE) {
    return { ok: false, reason: "invalid-or-unauthorized" };
  }
  const ids = new Set<number>();
  for (const value of values) {
    const id = parsePhotoId(value);
    if (id === null) return { ok: false, reason: "invalid-or-unauthorized" };
    ids.add(id);
  }
  return { ok: true, ids: [...ids] };
}

/** Chunk values while reserving parameter slots for other statement bindings. */
export function chunkD1Values<T>(values: readonly T[], reservedParameters = 0): T[][] {
  if (!Number.isInteger(reservedParameters) || reservedParameters < 0 || reservedParameters >= MAX_D1_BOUND_PARAMETERS) {
    throw new RangeError("reserved D1 parameters must be between 0 and 99");
  }
  const size = MAX_D1_BOUND_PARAMETERS - reservedParameters;
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/** Split an object-key list into R2-safe batches without reordering it. */
export function chunkR2Keys(keys: readonly string[], size = MAX_R2_DELETE_KEYS): string[][] {
  if (!Number.isInteger(size) || size <= 0 || size > MAX_R2_DELETE_KEYS) {
    throw new RangeError("R2 delete chunk size must be between 1 and 1000");
  }
  const chunks: string[][] = [];
  for (let offset = 0; offset < keys.length; offset += size) {
    chunks.push(keys.slice(offset, offset + size));
  }
  return chunks;
}

/** Collect originals, optional thumbnails, and every retained OG generation. */
export function collectPhotoObjectKeys(photos: readonly PurgePhotoRow[]): string[] {
  const keys = new Set<string>();
  for (const photo of photos) {
    keys.add(photo.r2_key);
    if (photo.thumb_key) keys.add(photo.thumb_key);
    for (const key of ogObjectKeysForPhoto(String(photo.id))) keys.add(key);
  }
  return [...keys];
}

/** Delete object keys in idempotent R2 batches. */
export async function deleteR2ObjectKeys(bucket: R2Bucket, keys: readonly string[]): Promise<void> {
  for (const chunk of chunkR2Keys([...new Set(keys)])) await bucket.delete(chunk);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** Resolve a complete owner-scoped set without exceeding D1's parameter ceiling. */
export async function resolveOwnedPhotos(
  db: D1Database,
  userId: number,
  ids: readonly number[],
): Promise<PurgePhotoRow[] | null> {
  const rows: PurgePhotoRow[] = [];
  for (const chunk of chunkD1Values(ids, 1)) {
    const result = await db
      .prepare(
        `SELECT id, r2_key, thumb_key
           FROM photos
          WHERE user_id = ? AND id IN (${placeholders(chunk.length)})`,
      )
      .bind(userId, ...chunk)
      .all<PurgePhotoRow>();
    rows.push(...result.results);
  }
  const resolved = new Map(rows.map((row) => [row.id, row]));
  if (resolved.size !== ids.length || ids.some((id) => !resolved.has(id))) return null;
  return ids.map((id) => resolved.get(id)!);
}

/** Atomically remove photo children, then owner-scoped photo parents. */
export async function deletePhotoRows(
  db: D1Database,
  userId: number,
  ids: readonly number[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkD1Values(ids, 1)) {
    const inClause = placeholders(chunk.length);
    const ownedPhotoIds = `SELECT id FROM photos WHERE user_id = ? AND id IN (${inClause})`;
    statements.push(
      db.prepare(`DELETE FROM favorites WHERE photo_id IN (${ownedPhotoIds})`).bind(userId, ...chunk),
      db.prepare(`DELETE FROM photo_tags WHERE photo_id IN (${ownedPhotoIds})`).bind(userId, ...chunk),
      db.prepare(`DELETE FROM photos WHERE user_id = ? AND id IN (${inClause})`).bind(userId, ...chunk),
    );
  }
  await db.batch(statements);
}

/** Ownership-enforced, R2-first purge for one or many photos. */
export async function purgePhotos(
  env: Pick<Env, "DB" | "BUCKET">,
  userId: number,
  submittedIds: readonly unknown[],
): Promise<PhotoPurgeResult> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return { ok: false, reason: "invalid-or-unauthorized" };
  }
  const parsed = parsePhotoIds(submittedIds);
  if (!parsed.ok) return parsed;

  let photos: PurgePhotoRow[] | null;
  try {
    photos = await resolveOwnedPhotos(env.DB, userId, parsed.ids);
  } catch {
    return { ok: false, reason: "d1-delete-failed" };
  }
  if (photos === null) return { ok: false, reason: "invalid-or-unauthorized" };

  try {
    await deleteR2ObjectKeys(env.BUCKET, collectPhotoObjectKeys(photos));
  } catch {
    return { ok: false, reason: "r2-delete-failed" };
  }

  try {
    await deletePhotoRows(env.DB, userId, parsed.ids);
  } catch {
    return { ok: false, reason: "d1-delete-failed" };
  }
  return { ok: true, deletedIds: parsed.ids };
}
