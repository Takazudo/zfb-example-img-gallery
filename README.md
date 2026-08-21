# Stillframe

Stillframe is a small, server-rendered photo gallery built with [zfb](https://github.com/Takazudo/zudo-front-builder), Preact, and Cloudflare's D1, R2, and Images bindings. It is intentionally a plain web application: forms submit to the Worker, the Worker writes the binding-backed state, and the response redirects back to a clean URL.

**Live:** `zfb.config.ts` sets the canonical origin to `https://zfb-example-img-gallery.takazudomodular.com`, which `lib/site.ts` resolves at request time. The production `[[routes]]` block is still commented in the checked-in `wrangler.toml`, so the custom domain is not active in this checkout. A deployed Workers URL has the form `https://zfb-example-img-gallery.<account>.workers.dev/` until the custom domain is enabled; see the [Cloudflare setup runbook](docs/cloudflare-setup.md).

The source currently exposes `SITE_NAME` and `SITE_TWITTER` (`Stillframe` and `@takazudo`) but no `SITE_ORIGIN` constant; the zfb `site` setting is the canonical-origin source of truth.

## What the demo does

- Shows a paged photo grid, with 24 photos per page.
- Renders a detail page for each photo.
- Lists authors and renders an author detail page with pagination.
- Lists tags and renders a paged tag detail page.
- Supports registration, login, and POST-only logout.
- Lets a signed-in user change their username, upload an avatar, or delete their account.
- Lets a signed-in user upload a photo with a title, plain-text description, and comma-separated tags.

Every mutation is a plain `<form method="post">` followed by a 303 redirect — the demo ships **zero client-side JavaScript**.

## Architecture

| Concern | How |
| --- | --- |
| Framework | zfb + Preact, Tailwind v4 (the v4 compiler ships inside the zfb binary — there is no `tailwindcss` dependency) |
| Rendering | **100% SSR** — every page exports `prerender = false`, except the single prerendered `pages/404.tsx` |
| Metadata | Cloudflare D1 (`env.DB`) |
| Image blobs | Cloudflare R2 (`env.BUCKET`), served through a Worker proxy route |
| Social cards | Cloudflare Images binding (`env.IMAGES`), generated once and persisted to R2 |
| Auth | email + password, PBKDF2 (Web Crypto), opaque server-side session cookie |
| Client JS | none |
| Deploy | GitHub Actions → `wrangler deploy`; D1 migrations applied in CI |

### Clean URLs, no `paths()`

Dynamic segments such as `/photos/[id]` and `/tags/[tag]` have `prerender = false`, so they are matched at request time and do not need a build-time `paths()` enumeration. This repo uses real path segments, not `?id=` query strings.

### `run_worker_first` must list every SSR prefix

The Static Assets layer runs before the Worker. For a navigation request (`sec-fetch-mode: navigate`, which a real browser sends), an unmatched path is answered by `not_found_handling`. With a prerendered `dist/404.html` present, an SSR route whose prefix is missing from `run_worker_first` serves the 404 page and the Worker never runs; a `curl` request without that header can fall through and return a correct 200. **The site can therefore be broken for humans while looking healthy to scripts.**

These are glob patterns. `/authors/*` does not match bare `/authors`, so each collection root appears alongside its wildcard. This is the current array from `wrangler.toml`:

```toml
run_worker_first = [
  "/", "/page/*",
  "/photos/*",
  "/authors", "/authors/*",
  "/tags", "/tags/*",
  "/img/*",
  "/og/*",
  "/robots.txt", "/sitemap.xml",
  "/register", "/login", "/logout", "/settings", "/upload",
]
```

`/assets/*` is deliberately absent so hashed CSS and the stable stylesheet are served straight from the edge without a Worker invocation.

### The stylesheet link is hard-coded on purpose

zfb injects a stylesheet link into generated (SSG) HTML only. This build is SSR-only apart from `404.html`, so `layouts/gallery-layout.tsx` hard-codes `<link rel="stylesheet" href="/assets/app.css">`. The postbuild step `scripts/stable-css.mjs` copies the one `dist/assets/styles-<hash>.css` match to that stable name and exits non-zero unless exactly one match exists. If an upstream change alters CSS emission, the failure is a **stable-css error, not a zfb error**.

## Routes

```text
/                                  photo grid, page 1
/page/[page]                       photo grid, page N
/photos/[id]                       photo detail
/authors                           authors having >= 1 photo
/authors/[username]                author detail, page 1
/authors/[username]/page/[page]    author detail, page N
/tags                              all tags + nav
/tags/[tag]                        tag detail, page 1
/tags/[tag]/page/[page]            tag detail, page N
/register  /login  /logout         auth (logout is POST-only)
/settings                          auth-gated: username, avatar, delete account
/upload                            auth-gated: photo + title + description + tags
/img/[...key]                      R2 object proxy
/og/v1/[id].jpg                    1200x630 social card
/robots.txt  /sitemap.xml          SSR, generated from D1
```

## Data model

The initial D1 migration creates these tables and columns:

```text
users(id, username UNIQUE, email UNIQUE, password_hash, password_salt, avatar_key NULL, created_at)
sessions(id, user_id, created_at, expires_at)
photos(id, user_id, title, description, r2_key UNIQUE, thumb_key NULL,
       content_type, width NOT NULL, height NOT NULL, blurhash NULL, created_at)
tags(id, name UNIQUE)                    -- stored lowercased
photo_tags(photo_id, tag_id)
```

Three choices are easy to miss:

- Email and username are normalised before storage and comparison: email is lowercased and trimmed, while usernames are lowercased (and NFKC-normalised by the account module) for uniqueness and URL lookup. SQLite's default `UNIQUE` comparison on `TEXT` is case-sensitive; without this, `Alice` and `alice` could be two accounts sharing `/authors/alice`.
- `width` and `height` are `NOT NULL` because every `<img>` carries them to prevent layout shift. A Worker does not decode an image; dimensions are parsed from the file header in `lib/image-dims.ts`.
- `blurhash` is stored but nothing renders it. It arrives with the source data, while using it would require re-downloading the set and either client JavaScript or a server-side decoder, both outside this zero-JS demo.

R2 keys are immutable UUID-based names. The stored original, grid variant, avatar, and derived card use these shapes:

```text
photos/{uuid}.{ext}          # stored original; ext comes from magic-byte sniffing, never the filename
thumbs/{uuid}.{ext}          # optional smaller grid variant
avatars/{uuid}.{ext}         # account avatar
derived/og/v1/{photoId}.jpg  # 1200x630 social card
```

R2 has no atomic rename. A key derived from a mutable title or filename would require copy-then-delete on every edit; immutable keys are also what justify `Cache-Control: public, max-age=31536000, immutable` on `/img/*`.

The write order is R2 `put()` first, then the D1 row. A crash between them leaves a recoverable orphan rather than a row pointing at a missing blob. Account deletion collects every original, thumbnail, avatar, and generated-card key, deletes the R2 objects first, and only if every R2 delete succeeds removes the D1 rows in one `batch()`. D1 `batch()` rolls back on a failing statement, while the R2 half does not, which is why R2 goes first.

There is deliberately no `og_key` column. The card key is derived from the photo id and the `v1` generation segment, so changing the crop is a code change rather than a data migration.

## Dependencies

This is a standalone package. The zfb packages are ordinary npm registry dependencies with no `file:` links; the `zfb` CLI ships as prebuilt platform binaries through optional dependencies, so the package-install step is the whole setup.

`@takazudo/zfb`, `@takazudo/zfb-runtime`, and `@takazudo/zfb-adapter-cloudflare` are exact-pinned and in lockstep at `2.8.0`. `wrangler` is also exact-pinned, at `4.85.0`. The package manager is pnpm `10.34.1`, and the required Node version is `>=22.12.0`. There is no `tailwindcss` dependency: Tailwind v4 is compiled inside the zfb binary.

## Local development

For a fresh checkout:

```sh
git clone <repository-url>
cd zfb-example-img-gallery
pnpm install --frozen-lockfile
pnpm build
```

The checked-in scripts are:

| Command | What it runs |
| --- | --- |
| `pnpm dev` | `zfb dev` (with the `predev` cleanup of generated output) |
| `pnpm build` | `zfb build` followed by `node scripts/stable-css.mjs` |
| `pnpm preview` | `zfb preview` |
| `pnpm typecheck` | `zfb check` |
| `pnpm test` | Vitest `unit`, `ssr`, and `handlers` projects |
| `pnpm test:all` | All Vitest projects, including `integration` |
| `pnpm dev:cf:setup` | Local D1 migration using `.wrangler/state`, then `pnpm build` |
| `pnpm dev:cf` | The binding-backed loop: setup, `wrangler dev` on port 8788, and a file watcher that rebuilds |

The route handlers read `env.DB`, `env.BUCKET`, or both, so `zfb dev` alone cannot provide a useful binding-backed gallery. Use `pnpm dev:cf`, or run the equivalent explicitly:

```sh
PERSIST=.wrangler/state
pnpm exec wrangler d1 migrations apply img-gallery --local --persist-to "$PERSIST"
pnpm build
pnpm exec wrangler dev --port 8788 --persist-to "$PERSIST"
```

`wrangler` is a project devDependency, so `pnpm exec wrangler` resolves the pinned version; no global install is needed. Do not run `pnpm dev` alongside the Wrangler loop: `predev` removes `dist/`, which is the directory `wrangler dev` is serving.

Local D1 and R2 data persists under `.wrangler/state/`. It resets only when that directory is deleted or the configured `database_name` / `bucket_name` changes. Keep the same `--persist-to` directory for every Wrangler command, the Worker, and any seed/backfill process.

## Seeding the demo gallery

The committed manifest contains 293 usable slugs. The procedure below is deliberately sequential and uses the real registration and upload path. The mirrored WebP files are gitignored; only `data/photos/slugs.txt` and `data/photos/manifest.json` are committed.

1. **Mirror the source photos.** Run `node scripts/mirror-photos.mjs`. The source list has 299 entries: 293 usable manifest slugs and six known dead slugs, which are excluded rather than retried. The script fetches `https://imgs.takazudomodular.com/images/p/{slug}/{size}.webp` for the `2000w` and `600w` tiers into `data/photos/`. The current manifest verifies 293 full-image records totaling 154,402,046 bytes (about 154 MB; mean about 515 KiB; maximum about 1.46 MiB); the mirrored 600w tier is approximately 19.6 MB but is not committed, so that aggregate cannot be checked in. `2000w` is a nominal ladder step, not a pixel guarantee: it means up to 2000 pixels on the long edge without upscaling. The source set is not uniformly square (37 of the 293 are non-square in the mirror measurement), so the grid's `object-fit: cover` is load-bearing. Optional flags are `--discover`, `--concurrency`, `--limit`, `--only`, and `--force`.
2. **Generate titles, descriptions, and tags.** Run `node scripts/describe-photos.mjs`. It writes the metadata into `data/photos/manifest.json`; `--limit`, `--only`, and `--out` are the available flags. Identity comes from the slug and product taxonomy. Form, material, view, and finish come from a zero-shot classifier over a curated vocabulary, with a `0.005` top-two margin gate that drops a facet rather than guessing. Colour comes from a background-subtracted pixel pass because the classifier reads colour from the backdrop otherwise. A generic captioner was rejected because fluent hallucinations are a worse failure than a plain sentence. The model downloads once (about 204 MB) and then runs offline; the full set takes roughly two minutes. The script chooses a local model cache directory from its environment or the platform default; do not commit that cache.
3. **Prepare the binding-backed stack and seed credentials.** Use `pnpm dev:cf` or the explicit loop above, with one stable `.wrangler/state` directory. Set `SEED_TAKAZUDO_EMAIL` and `SEED_TAKAZUDO_PASSWORD` in the shell only; the password must never be committed, put in `wrangler.toml`, or passed to `wrangler secret put`. The seeded account is created through normal registration, not by inserting a special D1 row.
4. **Upload through the real UI.** TODO: scripts/seed-upload.mjs is not present in this checkout yet, so there is no verified command to run here. The pending seeder must drive Playwright against `/upload`, register once (tolerating an existing account), log in once, reuse its session cookie, and upload the 293 manifest entries sequentially. It should accept `--base-url`, resume by skipping titles already present for the seed user, and collect per-item failures for a targeted retry. The expected full run is roughly 15–25 minutes; the value of this path is that it proves registration → login → upload → tag parsing → detail rendering rather than introducing a back-door writer.
5. **Backfill the thumbnails.** TODO: scripts/backfill-thumbs.mjs is not present in this checkout yet. The pending demo-only step must upload each mirrored `600w` object into R2 and set `thumb_key` in D1 in one batched `UPDATE` after the real uploads. It must accept `--base-url` and use the same local state directory as the Worker. Stop `wrangler dev` if local state locking prevents the backfill, run the backfill, then restart the Worker for verification. Genuine user uploads still have `thumb_key = NULL`; this backfill is not an application feature.

The current integration gap is intentional rather than hidden: add the two missing scripts before treating steps 4 and 5 as runnable. Never let the CLI, Worker, and backfill address different `.wrangler/state` directories.

## Known limitations

- **No thumbnail generation for user uploads.** A Worker cannot resize an image; image processing is CPU-bound work that can hit the Worker CPU ceiling. Seeded photos can have a `600w` thumbnail only because the source CDN publishes one. A genuine upload is stored as-is with `thumb_key = NULL`, and the grid falls back to `r2_key`. Close this gap with a variant pipeline at upload time or Cloudflare Image Resizing.
- **Upload size cap: 4 MiB (shown as 4 MB in the UI).** `MAX_UPLOAD_BYTES` is `4 * 1024 * 1024` in `lib/storage.ts`. The upload route rejects an oversized multipart envelope early using `Content-Length` (the envelope allowance is the image cap plus 64 KiB), then `validateAndStore()` checks the parsed image bytes definitively. The largest mirrored original recorded in the manifest is about 1.46 MiB, so the cap leaves roughly 2.7× headroom while bounding Worker memory and grid weight.
- **Uploads go through the Worker, not presigned URLs.** A presigned PUT would avoid the request-body limit, but would need another credential type and client-side JavaScript, giving up the zero-JS property.
- **Magic-byte MIME checks.** Only JPEG, PNG, and WebP are allowed, and the allowlist is enforced from file bytes rather than the declared `Content-Type`. A PNG renamed `.jpg` is rejected; the stored extension comes from the sniff.
- **Tags are deliberately constrained but free-form.** Input is comma-separated. Normalisation trims, strips one leading `#`, applies Unicode NFKC, lowercases, collapses whitespace to `-`, drops empties, and deduplicates. `/`, `%`, `?`, `#`, and control characters are rejected; each tag is 1–32 Unicode code points, with at most 10 tags per photo.
- **`blurhash` is stored but unused.** See the data-model note above.
- **Descriptions are plain text.** There is no Markdown parser; the detail page renders them with `white-space: pre-wrap`.

## Social cards and SEO

The detail page emits a full head: title, description, absolute canonical, `og:title`, `og:description`, `og:image`, `og:image:width` 1200, `og:image:height` 630, `og:image:alt`, `og:image:type`, `og:type=article`, `article:published_time`, `article:author`, `og:url`, `og:site_name`, and `og:locale`. It also emits `twitter:card=summary_large_image`, `twitter:site` (`@takazudo`), `twitter:image`, and `twitter:image:alt`, plus a schema.org `ImageObject` JSON-LD block.

`twitter:creator` is intentionally absent: anyone can register, so stamping every photo with one handle would misattribute other people's uploads. Authorship is carried by `article:author`. `twitter:title` and `twitter:description` are also absent because X falls back to the Open Graph values.

The source photos are square or near-square while social cards are landscape. `/og/v1/{id}.jpg` asks the Cloudflare Images binding (`env.IMAGES`) for `{ width: 1200, height: 630, fit: "cover", gravity: "auto" }`, outputs JPEG, and persists the result at `derived/og/v1/{id}.jpg`. Uploads attempt write-through generation after the photo row commits; the route lazily regenerates a missing card, so there is no migration script and no permanently broken card.

OG generation never fails an upload: the photo row commits first and generation failures are swallowed. The card route returns the committed static fallback at HTTP 200 with `Cache-Control: public, max-age=60` when generation fails, because a crawler caching an error can hide a card for days. An unknown photo id is still a real 404. Bumping `v1` to `v2` changes both the route and object-key prefix, so every card misses and regenerates; the old generation can then be deleted by prefix. Local `wrangler dev` implements `width`, `height`, `rotate`, and `format`, but not `gravity: "auto"`; verify salient-band cropping against a deployed preview.

## Deployment

The [Cloudflare setup runbook](docs/cloudflare-setup.md) is the source of truth for the ordered from-zero flow: API token, GitHub secrets, D1 and R2 resources, deploy, and verification. The repository secrets are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the runbook contains the permission table and must not be duplicated here.

On a push to `main`, GitHub Actions installs with the frozen lockfile, runs `pnpm typecheck`, `pnpm test`, and `pnpm build`, applies remote migrations to `img-gallery`, and runs `pnpm exec wrangler deploy` for the production environment. On a pull request it performs the same checks, applies migrations to `img-gallery-preview` with `--env preview`, and uploads a preview version with `--preview-alias pr-<N>`; it does not touch production resources. Migrations are applied by CI rather than by hand.

The current workflow does not yet contain the browser smoke files; the integration work must add that lane before claiming a browser-level CI result. See [TESTING.md](TESTING.md).

## Testing

The mandatory inner loop is:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run --project unit --project ssr --project handlers
```

The browser-driven smoke lane belongs in CI once the pending integration files land. Its strategy and agent rules are documented in [TESTING.md](TESTING.md).

## zfb upgrade procedure

Use the project skill [.claude/skills/l-handle-zfb-update/SKILL.md](.claude/skills/l-handle-zfb-update/SKILL.md). As a manual fallback, bump `@takazudo/zfb`, `@takazudo/zfb-adapter-cloudflare`, and `@takazudo/zfb-runtime` to the **same** exact-pinned version, then run `pnpm build && pnpm typecheck`. If the bump crosses an adapter release, manually re-test a binding-backed SSR route such as `/`, `/photos/<id>`, and `/upload` after deployment.
