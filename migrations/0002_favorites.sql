-- Durable current-favorite membership.
-- Every timestamp uses the repository's canonical UTC expression from 0001.

CREATE TABLE favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, photo_id)
);

-- Counts and photo-target cleanup both begin with the photo id.
CREATE INDEX idx_favorites_photo ON favorites (photo_id);

-- The personal collection is newest-favorited-first with a deterministic tie-breaker.
CREATE INDEX idx_favorites_user_created
  ON favorites (user_id, created_at DESC, photo_id DESC);
