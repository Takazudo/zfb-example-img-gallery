/** Row shapes and view DTOs mirroring migrations/0001_init.sql. */

export interface User {
  id: number;
  username: string;
  email: string;
  avatar_key: string | null;
  created_at: string;
}

/** User row plus credential columns — never leaves lib/db/account.ts + lib/auth.ts. */
export interface UserCredentials extends User {
  password_hash: string;
  password_salt: string;
}

/** The minimal identity the page shell renders (avatar + @username in the header). */
export interface SessionUser {
  id: number;
  username: string;
  avatar_key: string | null;
}

export interface Photo {
  id: number;
  user_id: number;
  title: string;
  description: string;
  r2_key: string;
  thumb_key: string | null;
  content_type: string;
  width: number;
  height: number;
  blurhash: string | null;
  created_at: string;
}

/** One tile in a thumbnail grid. Deliberately narrow — no description, no joins. */
export interface PhotoCard {
  id: number;
  title: string;
  r2_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  blurhash: string | null;
}

export interface Tag {
  id: number;
  name: string;
}

export interface TagWithCount extends Tag {
  photo_count: number;
}

export interface AuthorSummary {
  id: number;
  username: string;
  avatar_key: string | null;
  photo_count: number;
}

/** Everything the photo detail page and its head tags need, in one shape. */
export interface PhotoDetail {
  photo: Photo;
  author: SessionUser;
  tags: Tag[];
}

/** Pagination state, independent of what is being paged. */
export interface PageMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  offset: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface Paged<T> extends PageMeta {
  items: T[];
}

/** One sitemap entry for a photo. */
export interface PhotoSitemapEntry {
  id: number;
  created_at: string;
}
