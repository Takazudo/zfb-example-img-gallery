-- zfb-example-img-gallery — initial schema.
-- Applied by `wrangler d1 migrations apply <database_name>` (--local for dev,
-- --remote in CI). Wrangler records applied files in the d1_migrations table,
-- so this file runs exactly once per database.
-- All timestamps: ISO-8601 UTC with ms, identical to JS Date#toISOString() —
-- required by the og:article / JSON-LD head tags on the photo detail page.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stored already lowercased+trimmed (normalizeUsername / normalizeEmail).
  -- SQLite UNIQUE on TEXT is case-SENSITIVE, so without that normalisation
  -- `Alice` and `alice` are two accounts sharing one /authors/alice URL.
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  -- PBKDF2(SHA-256, 100k iterations), 256-bit digest + 16-byte salt, both hex.
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  avatar_key    TEXT,  -- R2 key, e.g. avatars/<uuid>.webp. NULL = no avatar.
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Opaque server-side sessions. `id` is the 32-byte-hex cookie value.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE photos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  -- Plain text. Never parsed as markdown; rendered with white-space: pre-wrap.
  description  TEXT NOT NULL DEFAULT '',
  -- Immutable key photos/<uuid>.<ext>, ext from magic-byte sniffing.
  r2_key       TEXT NOT NULL UNIQUE,
  -- Smaller grid variant. NULL for ordinary user uploads; grid falls back to r2_key.
  thumb_key    TEXT,
  content_type TEXT NOT NULL,
  -- NOT NULL: every <img> must carry width/height to prevent layout shift.
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  blurhash     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tags (            -- names stored already normalised and lowercased
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id),
  tag_id   INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (photo_id, tag_id)
);

-- Exactly the pagination sort, so paging is stable under concurrent inserts.
CREATE INDEX idx_photos_feed ON photos (created_at DESC, id DESC);
CREATE INDEX idx_photos_user ON photos (user_id);
CREATE INDEX idx_photo_tags_tag ON photo_tags (tag_id);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
