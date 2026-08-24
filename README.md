# Stillframe

Stillframe is a small, server-rendered photo gallery built with [zfb](https://github.com/Takazudo/zudo-front-builder), Preact, and Cloudflare's D1, R2, and Images bindings. It is intentionally a plain web application: forms submit to the Worker, the Worker writes the binding-backed state, and the response redirects back to a clean URL.

**Live:** [zfb-example-img-gallery.takazudomodular.com](https://zfb-example-img-gallery.takazudomodular.com). `zfb.config.ts` and the active production-only `[[routes]]` block in `wrangler.toml` share that canonical/Open Graph origin; `[env.preview]` explicitly clears the route. The permanent workers.dev URL remains available as an operational fallback; see the [Cloudflare setup runbook](docs/cloudflare-setup.md).

The source exposes `SITE_NAME` and `SITE_TWITTER` (`Stillframe` and `@takazudo`) but no `SITE_ORIGIN` constant; the zfb `site` setting and production custom-domain route are the matching origin contract.

## What the demo does

- Shows a paged photo grid, with 24 photos per page.
- Renders a detail page for each photo.
- Lists authors and renders an author detail page with pagination.
- Lists tags and renders a paged tag detail page.
- Supports registration, login, and POST-only logout.
- Lets a signed-in user change their username, upload an avatar, or delete their account.
- Lets a signed-in user upload a photo with a title, plain-text description, and comma-separated tags.
- Provides one global Display settings dialog for the gallery thumbnail ratio (Original, Portrait 3:4, Square 1:1, or Landscape 4:3) and width (Small, Medium, or Large). Choices are stored in local storage, synchronized across tabs, and applied to cards loaded later.
- Enhances the server-rendered 24-item pages with progressive infinite loading: a visible loading/error/end status, an automatic IntersectionObserver path, and a manual `Load next … photos` path. Each history entry keeps a bounded expanded-gallery snapshot so router navigation and Back can restore it; the canonical `/page/[page]` links remain the no-JavaScript fallback.

Every mutation remains a plain `<form method="post">` followed by a 303 redirect, so the application works with full navigations when JavaScript is unavailable. The intentional zfb client runtime progressively enhances same-origin navigation, soft-submits eligible forms, hydrates the theme toggle, and preserves the user's theme choice.

## Architecture

| Concern | How |
| --- | --- |
| Framework | zfb + Preact, Tailwind v4 (the v4 compiler ships inside the zfb binary — there is no `tailwindcss` dependency) |
| Rendering | **100% SSR** — every page exports `prerender = false`, except the single prerendered `pages/404.tsx` |
| Metadata | Cloudflare D1 (`env.DB`) |
| Image blobs | Cloudflare R2 (`env.BUCKET`), served through a Worker proxy route |
| Social cards | Cloudflare Images binding (`env.IMAGES`), generated once and persisted to R2 |
| Auth | email + password, PBKDF2 (Web Crypto), opaque server-side session cookie |
| Client JS | zfb navigation/island runtime + the theme toggle only |
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

`/assets/*` is deliberately absent so hashed and stable CSS/client runtime assets are served straight from the edge without a Worker invocation.

### Stable SSR assets are hard-coded on purpose

zfb rewrites generated (SSG) HTML to hashed assets, but dynamic documents returned by `htmlResponse()` are created after the build. `layouts/gallery-layout.tsx` therefore links `/assets/app.css` and `/assets/islands.js`. The postbuild step `scripts/stable-assets.mjs` discovers exactly one hashed stylesheet and exactly one generated islands entry (excluding chunks/resources), copies them to the stable names, verifies the islands alias byte-for-byte, and rejects missing relative runtime assets. The prerendered 404 suppresses the manual stable module tag because zfb injects its one hashed module entry during SSG.

### SPA navigation is progressive enhancement

The shared layout mounts zfb's `ClientRouter` with animated fallback, `data-theme` preservation, and traversal refetching. Refetching matters because these pages are per-request SSR: auth, D1 content, active navigation, title/meta, and header controls are server-authored and must be replaced on every swap, including repeated history URLs. The router keeps its accessible route announcer.

Forms intentionally have no `data-zfb-reload`. With the runtime active, eligible same-origin GET forms navigate with encoded queries; non-GET methods are transported as POST, multipart bodies remain `FormData`, URL-encoded forms keep their encoding, redirects update the final URL, and validation/error HTML swaps without replaying a mutation. Ordinary form markup remains the no-JavaScript fallback.

`zfb:after-swap` is a DOM-swap milestone: it fires before incoming scripts execute and before new islands mount or hydrate. Code that needs a newly hydrated island must use that island's own lifecycle rather than treating `zfb:after-swap` as a hydration event.

### Gallery display and infinite loading

The Display settings dialog is available from the global header on every page. It offers four ratios (Original, Portrait 3:4, Square 1:1, and Landscape 4:3) and three widths (Small 9rem, Medium 12.5rem, and Large 16rem). Preferences are versioned in local storage, restored before the first paint, synchronized with other tabs, preserved by zfb soft navigation, and inherited by newly appended cards. Original uses each image's intrinsic width and height; the other ratios crop with `object-fit: cover`.

The first server-rendered page always contains up to 24 cards and a canonical next-page link. With JavaScript, the controller can append the next page while keeping the current URL; an automatic load is one request per leave/re-enter intersection, while the visible link always remains a manual retry/fallback. Loading, one-shot non-success, retry, and terminal `All photos loaded` states are announced in the feed's live region. Router history stores only bounded per-entry markup snapshots, so a photo navigation followed by Back can restore the loaded cards and scroll position without requiring a full reload. Disabling JavaScript follows the ordinary `/page/[page]` link and renders that page directly.

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
/og/v2/[id].jpg                    1200x630 social card (v1 retained and generation-pinned)
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
- `blurhash` is nullable. New uploads ask the Cloudflare Images binding for a tiny, bounded raster and generate a fixed-4x4 hash best-effort; a transformation or decode failure leaves the value `NULL`. Legacy rows can be filled deliberately with `scripts/backfill-blurhash.mjs`, while presentation keeps a normal-image fallback for nullable data.

R2 keys are immutable UUID-based names. The stored original, grid variant, avatar, and derived card use these shapes:

```text
photos/{uuid}.{ext}          # stored original; ext comes from magic-byte sniffing, never the filename
thumbs/{uuid}.{ext}          # optional smaller grid variant
avatars/{uuid}.{ext}         # account avatar
derived/og/v2/{photoId}.jpg  # 1200x630 social card (v1 retained and generation-pinned)
```

R2 has no atomic rename. A key derived from a mutable title or filename would require copy-then-delete on every edit; immutable keys are also what justify `Cache-Control: public, max-age=31536000, immutable` on `/img/*`.

The write order is R2 `put()` first, then the D1 row. A crash between them leaves a recoverable orphan rather than a row pointing at a missing blob. Account deletion collects every original, thumbnail, avatar, and generated-card key, deletes the R2 objects first, and only if every R2 delete succeeds removes the D1 rows in one `batch()`. D1 `batch()` rolls back on a failing statement, while the R2 half does not, which is why R2 goes first.

There is deliberately no `og_key` column. The card key is derived from the photo id and generation segment: new cards use `v2`, while the `v1` route and objects remain retained and generation-pinned. Changing the card design is a code change rather than a data migration.

## Dependencies

This is a standalone package. The zfb packages are ordinary npm registry dependencies with no `file:` links; the `zfb` CLI ships as prebuilt platform binaries through optional dependencies, so the package-install step is the whole setup.

`@takazudo/zfb`, `@takazudo/zfb-runtime`, and `@takazudo/zfb-adapter-cloudflare` are exact-pinned and in lockstep at `2.10.1`. `wrangler` is also exact-pinned, at `4.85.0`. The package manager is pnpm `10.34.1`, and the required Node version is `>=22.12.0`. There is no `tailwindcss` dependency: Tailwind v4 is compiled inside the zfb binary.

The checked-in upload path keeps `sharp` Node-only: it is used by the operator backfill script, never imported by the Worker bundle. The `blurhash` package is shared by the Worker encoder and the Node backfill encoder.

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
| `pnpm build` | `zfb build` followed by `node scripts/stable-assets.mjs` |
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
3. **Prepare the binding-backed stack and seed credentials.** Use `pnpm dev:cf` or the explicit loop above, with one stable `.wrangler/state` directory. Set `SEED_TAKAZUDO_EMAIL` explicitly and set the required `SEED_TAKAZUDO_PASSWORD` in the shell only; the seeder has a built-in fallback email, but an explicit environment value makes the target account unambiguous. The password must never be committed, put in `wrangler.toml`, or passed to `wrangler secret put`. The seeded account is created through normal registration, not by inserting a special D1 row.
4. **Upload through the real UI.** Run the seeder against the binding-backed Worker:

   ```sh
   node scripts/seed-upload.mjs --base-url http://localhost:8788
   ```

   It defaults to `data/photos/manifest.json`, `data/photos/`, D1 `database_name`, and `.wrangler/state`. It requires `SEED_TAKAZUDO_PASSWORD`, uses `SEED_TAKAZUDO_EMAIL` when set, registers the normal `Takazudo` username once (tolerating an existing account), logs in once, and reuses one Playwright session for sequential `/upload` submissions. At startup it reads the seed user's existing titles and skips them, so titles are the resume authority; per-item file or upload failures are collected while the run continues and produce a non-zero exit status at the end. `--limit` bounds newly uploaded items, while `--photos-dir`, `--manifest`, `--d1`, `--persist-to`, `--remote`, and `--headed` are available for deliberate overrides. For a deployed Worker, pass its URL to `--base-url` and use `--remote` so the D1 lookup addresses the remote database. The complete 293-item run is expected to take roughly 15–25 minutes; this path proves registration → login → upload → tag parsing → detail rendering rather than introducing a back-door writer.
5. **Backfill the thumbnails.** This demo-only step reads the seed user's photo rows, matches them to the manifest by unique title, uploads each mirrored `600w` file to the derived `thumbs/{uuid}.webp` key, and writes `thumb_key` for successful puts in one generated SQL `UPDATE`. For local state, run it with the same persistence directory as the Worker:

   ```sh
   node scripts/backfill-thumbs.mjs --persist-to .wrangler/state
   ```

   D1 and bucket names default from `wrangler.toml`; `--photos-dir`, `--manifest`, `--d1`, `--bucket`, `--persist-to`, `--concurrency`, `--force`, and `--remote` are supported. Local mode uses Wrangler's `--local --persist-to`; remote mode uses `--remote` for D1 and S3-compatible R2 credentials from `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` (or `R2_ENDPOINT`) for object puts. The default bounded concurrency is four. Already populated thumbnails are skipped unless `--force` is supplied, and missing seeded rows or individual failures are reported without preventing other jobs from completing. Database rows whose titles are not in the seed manifest are treated as genuine user uploads and skipped normally, leaving `thumb_key = NULL`; this backfill is not an application feature.

6. **Backfill legacy BlurHashes (optional, deliberate).** New uploads already attempt the upload-time Images transformation, but old rows can still have `blurhash IS NULL`. This workflow scans every photo row by increasing immutable id; it is not tied to `data/photos/manifest.json`, never mutates an R2 object, and writes only successfully decoded hashes. The default work unit is bounded to 100 selected rows, four concurrent reads, a 4 MiB original/download cap, 16 million Sharp input pixels, 32×32 output, a 30-second row timeout, and 50 SQL updates per batch. `--limit`, `--concurrency`, `--max-object-bytes`, `--max-download-bytes`, `--max-pixels`, `--row-timeout-ms`, and `--sql-batch-size` can lower those budgets within the documented hard bounds.

   First inspect a local persisted state without changing D1 or R2:

   ```sh
   PERSIST=.wrangler/state
   node scripts/backfill-blurhash.mjs --d1 img-gallery --bucket img-gallery --persist-to "$PERSIST" --dry-run --limit 100
   ```

   Apply a bounded local batch after the dry run (stop `wrangler dev` first if the state lock is held):

   ```sh
   node scripts/backfill-blurhash.mjs --d1 img-gallery --bucket img-gallery --persist-to "$PERSIST" --limit 100
   ```

   A normal run updates with `WHERE id = … AND blurhash IS NULL`, so a concurrent writer is not clobbered. `--force` intentionally includes non-null rows and uses `WHERE id = …`; use it only when replacing hashes is the explicit goal. Failed rows remain nullable and are printed without image bytes or secrets, so rerunning the same bounded command is the recovery path. A typical result is `Backfill summary: selected 3, decoded 2, updated 2, conflicts 0, failed 1`.

   Remote mode is command construction for an operator who has deliberately chosen the resources; it does not infer the production names. Name both resources every time, and authenticate Wrangler with a token/account that can read the named D1/R2 resources and update the named D1 database:

   ```sh
   node scripts/backfill-blurhash.mjs --remote --d1 img-gallery --bucket img-gallery --dry-run --limit 100
   node scripts/backfill-blurhash.mjs --remote --d1 img-gallery --bucket img-gallery --limit 100
   ```

   The first remote command only selects, reads, decodes, and reports. The second performs D1 updates; neither command writes, replaces, or deletes an R2 object. Keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or an existing Wrangler login) out of files and shell history. This checkout documents the remote path but does not run a remote backfill.

For local mode, all Wrangler CLI operations and the dev server must address the same `.wrangler/state` directory. If local state locking prevents the backfill, stop `wrangler dev`, run the backfill, then restart the Worker for verification.

## Known limitations

- **No thumbnail generation for user uploads.** A Worker cannot resize an image; image processing is CPU-bound work that can hit the Worker CPU ceiling. Seeded photos can have a `600w` thumbnail only because the source CDN publishes one. A genuine upload is stored as-is with `thumb_key = NULL`, and the grid falls back to `r2_key`. Close this gap with a variant pipeline at upload time or Cloudflare Image Resizing.
- **Upload size cap: 4 MiB (shown as 4 MB in the UI).** `MAX_UPLOAD_BYTES` is `4 * 1024 * 1024` in `lib/storage.ts`. The upload route rejects an oversized multipart envelope early using `Content-Length` (the envelope allowance is the image cap plus 64 KiB), then `validateAndStore()` checks the parsed image bytes definitively. The largest mirrored original recorded in the manifest is about 1.46 MiB, so the cap leaves roughly 2.7× headroom while bounding Worker memory and grid weight.
- **Uploads go through the Worker, not presigned URLs.** A presigned PUT would avoid the request-body limit, but would need another credential type and upload-specific client code beyond the narrow navigation/theme runtime.
- **Magic-byte MIME checks.** Only JPEG, PNG, and WebP are allowed, and the allowlist is enforced from file bytes rather than the declared `Content-Type`. A PNG renamed `.jpg` is rejected; the stored extension comes from the sniff.
- **Tags are deliberately constrained but free-form.** Input is comma-separated. Normalisation trims, strips one leading `#`, applies Unicode NFKC, lowercases, collapses whitespace to `-`, drops empties, and deduplicates. `/`, `%`, `?`, `#`, and control characters are rejected; each tag is 1–32 Unicode code points, with at most 10 tags per photo.
- **Nullable BlurHash degradation.** Upload-time generation is best-effort and legacy rows may remain `NULL` until the deliberate backfill completes. The UI must keep its ordinary image/fallback path for those rows. Each new upload that reaches generation asks the Cloudflare Images binding for one small transformation, which consumes the account's Images transformation quota and may incur the applicable Images usage cost; if the quota is exhausted, the upload still keeps its original and the hash remains nullable.
- **Offset pagination has a concurrent-insert boundary.** The feed uses `created_at DESC, id DESC` with `LIMIT/OFFSET`; if a new photo is inserted between requests, a later offset can omit one item (or expose a repeat). Client-side append deduplication removes repeats, but it cannot recover an item shifted past the requested offset. Cursor pagination is intentionally outside this feature.
- **Descriptions are plain text.** There is no Markdown parser; the detail page renders them with `white-space: pre-wrap`.

## Social cards and SEO

The detail page emits a full head: title, description, absolute canonical, `og:title`, `og:description`, `og:image`, `og:image:width` 1200, `og:image:height` 630, `og:image:alt`, `og:image:type`, `og:type=article`, `article:published_time`, `article:author`, `og:url`, `og:site_name`, and `og:locale`. It also emits `twitter:card=summary_large_image`, `twitter:site` (`@takazudo`), `twitter:image`, and `twitter:image:alt`, plus a schema.org `ImageObject` JSON-LD block.

`twitter:creator` is intentionally absent: anyone can register, so stamping every photo with one handle would misattribute other people's uploads. Authorship is carried by `article:author`. `twitter:title` and `twitter:description` are also absent because X falls back to the Open Graph values.

The source photos are square or near-square while social cards are landscape. The current `/og/v2/{id}.jpg` card is a composed 1200x630 JPEG: a pre-baked `#141210` plate sits behind a contain-fitted photo in the left 510x510 square container, with the Takazudo mark on the right. Its drop shadow is an alpha silhouette: the source is padded transparently, a black fill is clipped into the source alpha with `composite: "in"`, a transparent border adds bleed, and an alpha-aware blur softens it before the shadow is drawn behind the photo. For transparent PNGs, the shadow follows the opaque content rather than the full image rectangle. See [the Cloudflare Images capability probe](docs/images-binding-capabilities.md) for the production binding evidence and supported composition operations.

Uploads attempt write-through generation after the photo row commits; the v2 route lazily regenerates a missing card, so there is no migration script and no permanently broken card.

OG generation never fails an upload: the photo row commits first and generation failures are swallowed. The card route returns the committed static fallback at HTTP 200 with `Cache-Control: public, max-age=60` when generation fails, because a crawler caching an error can hide a card for days. An unknown photo id is still a real 404. Each generation has its own route and object-key prefix, so the v2 rollout misses and regenerates under `derived/og/v2/`; the retained v1 objects stay available for their generation-pinned route.

Local verification has a broader limitation than the old crop warning. Miniflare's local Images implementation honours only `rotate`, `width`, `height`, and output format, and silently drops every drawn layer; a composite therefore renders locally as just the resized photo, with no error. The composed card is verifiable through `wrangler dev --remote`, a deployed preview, or `pnpm preview:og` (the offline `sharp` renderer). Use the [Cloudflare Images capability probe](docs/images-binding-capabilities.md) as the reference for what the production binding actually supports.

## Deployment

The [Cloudflare setup runbook](docs/cloudflare-setup.md) is the source of truth for the ordered from-zero flow: API token, GitHub secrets, D1 and R2 resources, deploy, and verification. The repository secrets are `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the runbook contains the permission table and must not be duplicated here.

GitHub Actions always installs with the frozen lockfile and runs the typecheck, Vitest, build, invariant, and browser gates. Until the two bootstrap UUIDs and repository secrets are configured, it reports that Cloudflare deployment is deferred while keeping those local gates mandatory. Once configured, a push to `main` applies remote migrations to `img-gallery` and runs `pnpm exec wrangler deploy` for production. A pull request instead migrates `img-gallery-preview` with `--env preview` and uploads a preview version with `--preview-alias pr-<N>`; it never touches production resources. Migrations are applied by CI rather than by hand. The initial production deploy uses the permanent `workers.dev` URL; activate the custom domain only after production has been seeded, because the custom-domain smoke requires at least three server-rendered photos.

The workflow runs the `@smoke` Playwright lane before either deployment, uploads its diagnostics on failure or cancellation, and runs `scripts/smoke.mjs` against production after a successful main-branch deploy. See [TESTING.md](TESTING.md).

## Testing

The mandatory inner loop is:

```sh
pnpm exec tsc --noEmit
pnpm exec vitest run --project unit --project ssr --project handlers
```

The browser-driven `@smoke` lane is part of the T1 CI gate. Its strategy and agent rules are documented in [TESTING.md](TESTING.md).

## zfb upgrade procedure

Use the project skill [.claude/skills/l-handle-zfb-update/SKILL.md](.claude/skills/l-handle-zfb-update/SKILL.md). As a manual fallback, bump `@takazudo/zfb`, `@takazudo/zfb-adapter-cloudflare`, and `@takazudo/zfb-runtime` to the **same** exact-pinned version, then run `pnpm build && pnpm typecheck`. If the bump crosses an adapter release, manually re-test a binding-backed SSR route such as `/`, `/photos/<id>`, and `/upload` after deployment.
