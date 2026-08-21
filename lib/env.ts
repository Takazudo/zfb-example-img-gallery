/** Worker binding shape. SSR routes read it via `getCloudflareContext<Env>()`. */
export interface Env {
  /** D1 — users, sessions, photos, tags. */
  DB: D1Database;
  /** R2 — photo/avatar blobs and derived social cards. Private bucket. */
  BUCKET: R2Bucket;
  /** Cloudflare Images — off-Worker transforms for social cards. */
  IMAGES: ImagesBinding;
  /** Static Assets, for committed files such as the fallback social card. */
  ASSETS: Fetcher;
}
