-- Fast, local browser fixture. Wrangler applies this after migrations and
-- before the dev Worker starts; every statement is safe to repeat.
--
-- The rows deliberately point at synthetic, valid image keys. Playwright
-- intercepts /img/**, so this fixture never needs an R2 upload.
INSERT OR IGNORE INTO users (
  id, username, email, password_hash, password_salt, avatar_key, created_at
) VALUES (
  900001,
  'e2e-fixture',
  'e2e-fixture@example.test',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '00000000000000000000000000000000',
  NULL,
  '2026-01-01T00:00:00.000Z'
);

INSERT OR IGNORE INTO tags (id, name) VALUES (900001, 'e2e-fixture');

WITH RECURSIVE fixture(n) AS (
  SELECT 1
  UNION ALL
  SELECT n + 1 FROM fixture WHERE n < 50
)
INSERT OR IGNORE INTO photos (
  user_id, title, description, r2_key, thumb_key, content_type,
  width, height, blurhash, created_at
)
SELECT
  900001,
  'E2E fixture photo ' || printf('%02d', n),
  'Deterministic browser fixture photo ' || printf('%02d', n),
  'photos/00000000-0000-4000-8000-0000000000' || printf('%02d', n) || '.png',
  NULL,
  'image/png',
  CASE WHEN n % 2 = 0 THEN 160 ELSE 240 END,
  CASE WHEN n % 2 = 0 THEN 240 ELSE 160 END,
  CASE WHEN n % 3 = 2 THEN 'Ub86Xpt:fQt:t:o#fQo#fQfQfQfQt:o#fQo#' ELSE NULL END,
  '2026-01-01T00:00:' || printf('%02d', n) || '.000Z'
FROM fixture;

-- Keep reruns deterministic when the pinned local D1 already has the rows.
UPDATE photos
SET blurhash = CASE WHEN CAST(substr(r2_key, -6, 2) AS INTEGER) % 3 = 2
  THEN 'Ub86Xpt:fQt:t:o#fQo#fQfQfQfQt:o#fQo#'
  ELSE NULL
END
WHERE user_id = 900001;

INSERT OR IGNORE INTO photo_tags (photo_id, tag_id)
SELECT id, 900001
FROM photos
WHERE user_id = 900001
  AND r2_key LIKE 'photos/00000000-0000-4000-8000-0000000000__.png';
