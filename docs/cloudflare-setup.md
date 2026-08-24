# Cloudflare setup: zero to deployed gallery

This is the complete provisioning order for `Takazudo/zfb-example-img-gallery`. Run it from the
repository root with Node.js `>=22.12.0`, pnpm `10.34.1`, and an authenticated GitHub CLI. The
deployment target is Cloudflare Workers with Static Assets; this is not a Pages deployment. The
commands use the exact Wrangler version pinned in `package.json`, so run `pnpm install --frozen-lockfile`
before using any command in this document.

## What you are provisioning

| Piece | Value |
| --- | --- |
| Deploy target | Cloudflare **Workers** (Static Assets), not Pages |
| Production Worker | `zfb-example-img-gallery` |
| Preview Worker | `zfb-example-img-gallery-preview` (the default name for `[env.preview]`) |
| D1 databases | `img-gallery` (production) and `img-gallery-preview` (PR previews) |
| R2 buckets | `img-gallery` (production) and `img-gallery-preview` (PR previews) |
| Bindings | `env.DB` (D1), `env.BUCKET` (R2), `env.IMAGES` (Cloudflare Images), `env.ASSETS` (Static Assets) |
| Custom domain | `zfb-example-img-gallery.takazudomodular.com` (production only) |
| Worker secrets | **None** |

The production and preview resources are deliberately separate. A pull request must never write to
the production Worker, database, or bucket. Keep the two database UUIDs out of this document and
replace the placeholders in `wrangler.toml` only after the bootstrap step below returns them.

## 1. Enable R2 and Images on the account

These are account-level opt-ins. They are not token permissions, so adding permissions to an API
token cannot enable them.

1. In the Cloudflare dashboard, open **R2** and complete the one-time enablement. R2 requires a
   payment method on file. The demo dataset is approximately 174 MB across approximately 586
   objects, comfortably below the Standard R2 free allowance of 10 GB-month.
2. Open **Images** and enable the transformations feature. `env.IMAGES` generates the 1200x630
   social cards from the private R2 originals. Images Free includes 5,000 unique transformations
   per month; additional transformations cost $0.50 per 1,000. After the cap, new transformations
   return `9422`, while already-cached transformations continue to serve. This design persists one
   transformation per photo per generation, so the 293-photo seed consumes approximately 293
   transformations.

The `IMAGES` binding is authenticated by the platform and needs **no API-token permission at
runtime**. Grant **Cloudflare Images — Read** only when an operator needs to read transformation
usage through the API.

Confirm that `takazudomodular.com` is an active Cloudflare zone in this same account before
creating the token. If the domain has not been added yet, add it to the account and complete its
nameserver delegation first; the zone-scoped route permission and the production custom domain
cannot be created against a zone owned by another account.

## 2. Create the Cloudflare API token

In **My Profile → API Tokens → Create Custom Token**, create the token used by both the GitHub
Actions workflows and a human operator. Under **Account Resources → Include**, include the account
that owns this project. For the zone-scoped permission, use **Zone Resources → Include →
`takazudomodular.com`**. Do not paste the token value into a file, command history, commit, or this
document.

| Permission | Scope | CI | Human operator | Why it is needed |
| --- | --- | --- | --- | --- |
| **Workers Scripts — Edit** | Account | required | required | `pnpm exec wrangler deploy`, `pnpm exec wrangler versions upload`, and Static Assets uploads |
| **Workers R2 Storage — Edit** | Account | required | required | `pnpm exec wrangler r2 bucket create`, `pnpm exec wrangler r2 object put/get/delete`, and deploy-time validation of the `BUCKET` binding |
| **D1 — Edit** | Account | required | required | `pnpm exec wrangler d1 create`, `pnpm exec wrangler d1 list`, `pnpm exec wrangler d1 migrations apply --remote`, and `pnpm exec wrangler d1 execute --remote` |
| **Account Settings — Read** | Account | required | required | Lets Wrangler resolve which account the token belongs to |
| **Workers Routes — Edit** | Zone (`takazudomodular.com`) | required | required | Creates the `custom_domain = true` route for the production hostname |
| **Cloudflare Images — Read** | Account | not needed | optional | Reads transformation usage against the 5,000/month cap; the `IMAGES` binding itself does not use this token |

The dashboard may display the R2 write capability as **Workers R2 Storage — Edit** (the API
permission group is sometimes labelled `Workers R2 Storage Write`). Select the account-level
capability that permits bucket creation and object read/write/list operations.

Also record the **Account ID** from **Workers & Pages** in the dashboard's right-hand sidebar. It
is an identifier, not a secret, but keep its value in the shell or GitHub secret rather than in
source control.

Two permission failures are intentionally late:

- **A token without Workers Routes fails late, not early.** The Worker bundle uploads, then the
  route step errors. The site may still appear to work on `*.workers.dev`; this is a token problem,
  not a Worker configuration problem.
- **A token without Workers R2 Storage does not fail at deploy at all.** The Worker can deploy,
  but the first request touching `/img/*` or the upload form breaks. Add the permission before the
  first deploy rather than waiting for the first bug report.

The thumbnail backfill has one separate credential option. If it is run through an S3-compatible
client instead of `pnpm exec wrangler r2 object put`, mint an **R2 access key ID + secret access
key** in **R2 → Manage R2 API Tokens**. These credentials are human-only, belong in the operator's
shell for the duration of the backfill, and must never become GitHub secrets. They are not part of
the Workers API token above.

## 3. Set the two GitHub Actions secrets

Authenticate `gh` to the repository, then set exactly these two repository secrets. The commands
prompt for each value without putting it in the command line:

```sh
gh secret set CLOUDFLARE_API_TOKEN  --repo Takazudo/zfb-example-img-gallery
gh secret set CLOUDFLARE_ACCOUNT_ID --repo Takazudo/zfb-example-img-gallery
gh secret list --repo Takazudo/zfb-example-img-gallery
```

The list should contain `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. There are **no Worker
secrets** in this project: never run `pnpm exec wrangler secret put` for the seed password or any
other application value. Rotating the API token means rerunning the first command above; no code
change or redeploy is needed until the next push.

## 4. Create the D1 databases and R2 buckets

The normal path is the `workflow_dispatch`-only bootstrap workflow. It runs in GitHub, where the
two `CLOUDFLARE_*` secrets are available, creates both D1 databases and both R2 buckets
idempotently, resolves the canonical D1 UUIDs with `pnpm exec wrangler d1 list --json`, and publishes
the IDs in the step summary and a downloadable `d1-ids` artifact.

Run it from the repository:

```sh
gh workflow run bootstrap.yml --repo Takazudo/zfb-example-img-gallery --ref main
gh run list --repo Takazudo/zfb-example-img-gallery --workflow bootstrap.yml --limit 1
gh run watch <run-id> --repo Takazudo/zfb-example-img-gallery
gh run download <run-id> --repo Takazudo/zfb-example-img-gallery -n d1-ids
cat d1-ids.json
```

Use the run ID for the workflow invocation you just started. The downloaded JSON has the
production UUID for `img-gallery` and the preview UUID for `img-gallery-preview`. Paste those two
UUIDs into the two `database_id` fields in `wrangler.toml`, under `[[d1_databases]]` and
`[[env.preview.d1_databases]]`, respectively. Commit that configuration change before deploying.

If the workflow reports that it cannot create the buckets, or if an operator needs to provision
from a workstation instead, use the manual path below. Export credentials only in the current
shell; never commit them. If a resource already exists, continue and use the list commands to
confirm its canonical name and ID.

```sh
export CLOUDFLARE_API_TOKEN='TOKEN_FROM_CLOUDFLARE'
export CLOUDFLARE_ACCOUNT_ID='ACCOUNT_ID_FROM_DASHBOARD'

pnpm exec wrangler d1 create img-gallery
pnpm exec wrangler d1 create img-gallery-preview
pnpm exec wrangler r2 bucket create img-gallery
pnpm exec wrangler r2 bucket create img-gallery-preview
pnpm exec wrangler d1 list --json
pnpm exec wrangler r2 bucket list
```

Do **not** enable public access on either R2 bucket. Photos are served only through the Worker
proxy route `/img/[...key]`, and the social-card generator reads raw bytes through the binding.
Private buckets are a deliberate property of this design.

## 5. Confirm the `wrangler.toml` bindings

Before the first deploy, reconcile the committed file with this shape. The UUID placeholders below
stand for the values returned by `pnpm exec wrangler d1 list --json`; do not copy placeholder text
into a live configuration. This repository has already completed its seed and therefore keeps the
production route active. For a fresh account, temporarily comment that route for the initial
workers.dev deployment, seed the production database, then restore it as described in sections 8
and 9. Never leave `zfb.config.ts` pointing at a hostname that will remain unattached.

```toml
name = "zfb-example-img-gallery"
compatibility_date = "2026-08-01"

# REQUIRED. The zfb Cloudflare adapter threads `env` into SSR routes via
# AsyncLocalStorage from `node:async_hooks`; without this the Worker will not boot.
compatibility_flags = ["nodejs_compat"]

main = "./dist/_worker.js"

# These two keys MUST stay above the first table header: in TOML any key written
# after a table header belongs to that table.
workers_dev = true
preview_urls = true

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "404-page"

# Every route in this app is SSR. The asset layer runs before the Worker, so a
# navigation request for an unlisted path is answered by dist/404.html instead.
# These are globs: "/authors/*" does not match bare "/authors".
# "/assets/*" is deliberately absent so hashed CSS is served straight from the edge.
run_worker_first = [
  "/", "/page/*",
  "/photos/*",
  "/authors", "/authors/*",
  "/tags", "/tags/*",
  "/img/*",
  "/og/*",
  "/register", "/login", "/logout", "/settings", "/upload",
]

# Cloudflare Images RPC used to generate the 1200x630 social cards.
[images]
binding = "IMAGES"

# PRODUCTION ONLY. Keep this block above [env.preview].
[[routes]]
pattern = "zfb-example-img-gallery.takazudomodular.com"
custom_domain = true

[[d1_databases]]
binding = "DB"
database_name = "img-gallery"
database_id = "<uuid from pnpm exec wrangler d1 list>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "img-gallery"

[env.preview]
# `routes` is inheritable; this explicit empty list prevents a PR from
# claiming the production custom domain.
routes = []

[env.preview.images]
binding = "IMAGES"

[[env.preview.d1_databases]]
binding = "DB"
database_name = "img-gallery-preview"
database_id = "<uuid from pnpm exec wrangler d1 list>"

[[env.preview.r2_buckets]]
binding = "BUCKET"
bucket_name = "img-gallery-preview"
```

Bindings are not inherited by named environments. If production has a `DB`, `BUCKET`, or `IMAGES`
binding that `[env.preview]` lacks, fix the configuration before deploying; otherwise the PR
preview will bind to nothing or to the wrong resource. Keep the `ASSETS` Static Assets binding and
the production route at the top level exactly as shown.

## 6. Apply migrations locally and remotely

Pin one persistence directory for every local command. Keep this variable in the same shell (or
re-export it) when starting the local Worker, running the seed, and running the thumbnail backfill;
otherwise those commands can address different local D1/R2 state.

```sh
PERSIST=.wrangler/state

# Local production-shaped D1 state.
pnpm exec wrangler d1 migrations apply img-gallery --local --persist-to "$PERSIST"

# Remote production database (the path CI runs on a push to main).
pnpm exec wrangler d1 migrations apply img-gallery --remote

# Remote preview database (the path CI runs for a pull request).
pnpm exec wrangler d1 migrations apply img-gallery-preview --env preview --remote
```

Migrations are applied by CI before each deploy. Wrangler records completed files in the
`d1_migrations` table, so rerunning the commands is safe and applies only new migrations. The
local command must be repeated after a fresh checkout if `.wrangler/state` has been removed.

## 7. Seed the gallery with demo data

The demo seed creates 293 photos, all posted by one account, **`@Takazudo`**, through the normal
registration and upload paths. The seven steps below are intentionally sequential.

1. **Mirror the source photos.**

   Run `node scripts/mirror-photos.mjs`. It downloads the two size tiers for the 293 usable slugs
   from `https://takazudomodular.com/images/p/{slug}/{size}.webp` into the gitignored
   `data/photos/` directory: `2000w` is the full image (approximately 154 MB), and `600w` is the
   thumbnail source (approximately 19.6 MB). Six slugs in the 299-entry source list are dead
   upstream and are skipped rather than retried. This step does not write to R2 and takes roughly
   1.5 minutes.

2. **Generate descriptions.**

   Run `node scripts/describe-photos.mjs`. It writes the title, description, and tags for each
   photo to `data/photos/manifest.json`. The script downloads a model of approximately 204 MB once
   and is offline afterwards; the set takes roughly 2 minutes.

3. **Bring up the local stack with real bindings.**

   Run these commands using the same `PERSIST` value from section 6. Leave the Worker running in
   one terminal and use a second terminal for the remaining seed steps.

   ```sh
   pnpm exec wrangler d1 migrations apply img-gallery --local --persist-to "$PERSIST"
   pnpm build
   pnpm exec wrangler dev --port 8788 --persist-to "$PERSIST"
   ```

4. **Export the seed account credentials.**

   The password is required and the seeder fails before launching a browser when it is unset.
   `SEED_TAKAZUDO_EMAIL` is optional, but setting a fixed address makes the target account
   unambiguous. Enter the password interactively so it does not appear in shell history:

   ```sh
   export SEED_TAKAZUDO_EMAIL='seed@example.invalid'
   read -r -s -p 'Seed password: ' SEED_TAKAZUDO_PASSWORD
   printf '\n'
   export SEED_TAKAZUDO_PASSWORD
   ```

   `SEED_TAKAZUDO_PASSWORD` must never appear in a file, commit message, `wrangler.toml`, GitHub
   secret, or `pnpm exec wrangler secret put` command. The application never reads that environment
   variable after registration; it stores only the PBKDF2 hash produced by normal registration.

5. **Run the seeder through `/upload`.**

   ```sh
   node scripts/seed-upload.mjs --base-url http://localhost:8788
   # Or, only when intentionally seeding the deployed Worker:
   node scripts/seed-upload.mjs --base-url https://zfb-example-img-gallery.takazudomodular.com --remote
   ```

   The script registers `@Takazudo` (tolerating “already exists”), logs in once, and uploads all
   293 photos through the real `/upload` form. It is sequential (one upload at a time), resumable
   (it reads the seed user's existing titles and skips them), and non-fatal per item (failures are
   collected and reported at the end for a targeted rerun). Budget 3–5 seconds per photo, or
   approximately 15–25 minutes for the complete one-time run.

6. **Backfill thumbnails.**

   A genuine form upload intentionally leaves `thumb_key` NULL, so the grid would otherwise send a
   2000x2000 original into a 200px square. Run the demo-only backfill to upload each mirrored
   `600w` object and set its `thumb_key`:

   ```sh
   node scripts/backfill-thumbs.mjs --persist-to .wrangler/state
   ```

   This is a demo-seed step, not an application feature. Database rows absent from the seed
   manifest are skipped as genuine user uploads; they keep no thumbnail and the grid falls back
   to the full image. If local state reports a lock, stop
   `pnpm exec wrangler dev`, run the backfill, then restart the Worker for verification. If the
   deployed database is the target, pass `--remote`; that mode uses the separate R2 credentials
   from section 2 for S3-compatible object puts, and those values must remain shell-only.

7. **Backfill legacy BlurHashes (optional, deliberate).** The upload route attempts a bounded
   Cloudflare Images transformation for every new photo, but older rows can still have
   `blurhash IS NULL`. This workflow scans all `photos` rows by increasing id, reads each original
   without changing its R2 object, decodes it with Node-only Sharp, and updates only successful
   hashes. It is not tied to the checked-in seed manifest. Defaults are 100 selected rows per run,
   four concurrent rows, 4 MiB original/download buffers, 16 million Sharp input pixels, a
   32×32 maximum raster, a 30-second per-row timeout, and 50 SQL statements per batch. Failed
   rows remain resumable and are reported without image bytes or credentials.

   Preview local state first, then apply a bounded batch using the same persistence directory:

   ```sh
   PERSIST=.wrangler/state
   node scripts/backfill-blurhash.mjs --d1 img-gallery --bucket img-gallery --persist-to "$PERSIST" --dry-run --limit 100
   node scripts/backfill-blurhash.mjs --d1 img-gallery --bucket img-gallery --persist-to "$PERSIST" --limit 100
   ```

   `--dry-run` selects, reads, decodes, and reports only: it performs zero D1 updates and zero R2
   mutations. Normal updates retain `WHERE blurhash IS NULL`; `--force` is the explicit opt-in to
   overwrite a non-null value. If local D1 is locked, stop `wrangler dev`, run the script, and
   restart the Worker. A summary such as `Backfill summary: selected 3, decoded 2, updated 2,
   conflicts 0, failed 1` gives the resume/failure checkpoint.

   Remote mode must name both resources; it never silently selects the production bindings:

   ```sh
   # Requires Wrangler authentication with D1 read/write and R2 read access for these names.
   node scripts/backfill-blurhash.mjs --remote --d1 img-gallery --bucket img-gallery --dry-run --limit 100
   node scripts/backfill-blurhash.mjs --remote --d1 img-gallery --bucket img-gallery --limit 100
   ```

   The dry run is read/decode/report only. The apply command writes D1 hashes and never writes,
   replaces, or deletes an R2 object. Keep `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (or
   an existing Wrangler login) out of files and shell history. This runbook documents the remote
   path; this checkout did not execute a remote backfill.

Each new upload that reaches hash generation consumes one Cloudflare Images transformation from
the account's quota and may incur the applicable Images usage cost. If the quota or transformation
service is unavailable, the original upload still succeeds and the nullable hash falls back to the
ordinary image path. The fixed-4x4 contract and local/remote bounds are enforced by the script;
tune them down with its bounded flags rather than removing the safety limits.

Run the seven steps locally first to validate the complete flow. After the first production deploy,
run the seeder and backfill once more against the permanent `workers.dev` URL printed by Wrangler
to populate the production D1 and R2 resources (the local state is not uploaded by deployment).
The seeder's resume behavior makes this safe:

```sh
ACCOUNT_SUBDOMAIN=your-workers-subdomain
LIVE_BASE="https://zfb-example-img-gallery.${ACCOUNT_SUBDOMAIN}.workers.dev"
node scripts/seed-upload.mjs --base-url "$LIVE_BASE" --remote
node scripts/backfill-thumbs.mjs --remote
# Only after an explicit dry run against the intended database and bucket:
node scripts/backfill-blurhash.mjs --remote --d1 img-gallery --bucket img-gallery --limit 100
```

Keep `SEED_TAKAZUDO_PASSWORD` in the shell only for this operation. Do not run the live commands
against a preview URL unless the intent is to seed that PR's isolated database and bucket.

## 8. Make the first deploy

The checked-in workflow is event-aware; there is nothing to click after the repository and
configuration are ready.

Before the UUIDs and repository secrets are configured, the same workflow still runs every local
typecheck, test, build, invariant, and browser gate, then reports that Cloudflare deployment is
deferred. This allows the bootstrap workflow itself to land on `main` without a guaranteed-red
first deployment.

- A **push to `main`** builds, checks, applies migrations to `img-gallery`, runs
  `pnpm exec wrangler deploy` for production, publishes the permanent `workers.dev` URL, attaches
  the production custom domain when its route block is active, and smoke-tests that domain.
- A **pull request** builds, applies migrations to the separate `img-gallery-preview` database,
  then runs `pnpm exec wrangler versions upload --env preview --preview-alias pr-<N>`. The workflow
  posts a sticky comment with the preview URL. A PR never touches the production Worker, database,
  or bucket.

For the first infrastructure deploy, commit the two UUID replacements from section 4 while leaving
the existing custom-domain block commented. This deploy creates the Worker and applies the schema
without exposing an unseeded custom hostname. Review the diff, commit the UUIDs, and push through a
pull request:

```sh
git diff -- wrangler.toml
git add wrangler.toml
git commit -m 'Configure Cloudflare gallery resources'
git push
gh run list --repo Takazudo/zfb-example-img-gallery --workflow deploy.yml --limit 5
gh run watch <run-id> --repo Takazudo/zfb-example-img-gallery
```

Use the production `workers.dev` URL printed by the post-merge deployment to complete the remote
seed and thumbnail backfill (and, if wanted, the deliberate BlurHash backfill) from section 7. The production smoke deliberately requires at least
three D1-backed photo titles, so seed before activating the custom domain. Until activation, the
configured canonical and `og:image` hostname is intentionally not the verification target.

After seeding, uncomment this top-level block in `wrangler.toml` (it must remain above
`[env.preview]`):

```toml
[[routes]]
pattern = "zfb-example-img-gallery.takazudomodular.com"
custom_domain = true
```

Review the route-only diff, commit it on a branch, and merge it:

```sh
git diff -- wrangler.toml
git add wrangler.toml
git commit -m 'Activate the gallery custom domain'
git push
gh run list --repo Takazudo/zfb-example-img-gallery --workflow deploy.yml --limit 5
gh run watch <run-id> --repo Takazudo/zfb-example-img-gallery
```

To redeploy without a code change, select a completed run from the list and rerun it:

```sh
gh run rerun <run-id> --repo Takazudo/zfb-example-img-gallery
```

## 9. Confirm the custom domain

The production hostname is attached by `pnpm exec wrangler deploy` from the top-level
`[[routes]]` block with `custom_domain = true`. Cloudflare creates and manages the DNS record and
TLS certificate; there is no separate route command.

Check all three invariants:

1. The `[[routes]]` block is above `[env.preview]`. In TOML, every table written after
   `[env.preview]` belongs to that environment.
2. The API token has **Workers Routes — Edit** on the `takazudomodular.com` zone. Without it, the
   Worker uploads and only the route step fails.
3. `[env.preview]` keeps `routes = []`. Routes are inheritable, so omitting the explicit empty list
   lets a PR preview claim the real production domain.

While DNS and TLS are provisioning, verify the permanent workers.dev URL instead:

```text
https://zfb-example-img-gallery.<account>.workers.dev/
```

The top-level `workers_dev = true` keeps that URL available, and PR preview aliases also depend on
the workers.dev subdomain. Once the custom hostname answers, use it as `BASE` in section 10.

## 10. Verify the live site

Every SSR verification request must carry `-H 'sec-fetch-mode: navigate'`. This header makes the
request follow the same navigation path as a real browser. Without it, curl can fall through the
Static Assets layer and return a correct 200 even when the Worker is broken for every browser
navigation.

```sh
BASE=https://zfb-example-img-gallery.takazudomodular.com
NAV='-H sec-fetch-mode:navigate'

# Every bare collection root is listed explicitly because "/authors/*" does not match "/authors".
for p in / /authors /tags /register /login; do
  printf '%s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' $NAV "$BASE$p"        # 200 each
done

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/assets/app.css"  # 200: styles shipped
curl -s -o /dev/null -w '%{http_code}\n' $NAV "$BASE/settings"   # 303: auth-gated redirect
```

A 200 on `/assets/app.css` together with a 500 on `/` identifies a deployed Worker whose D1 or R2
binding is wrong. The asset layer is healthy; inspect the binding blocks and resource IDs.

Then exercise one real photo and its social card end to end:

```sh
ID=$(curl -s $NAV "$BASE/" | grep -oE '/photos/[0-9]+' | head -1 | grep -oE '[0-9]+')

curl -s -o /dev/null -w '%{http_code}\n' $NAV "$BASE/photos/$ID"          # 200
curl -s $NAV "$BASE/photos/$ID" | grep -c 'og:image'                      # 1: metadata present
curl -sI $NAV "$BASE/og/v1/$ID.jpg" | grep -iE '^(HTTP|content-type|cache-control)'
curl -s $NAV "$BASE/og/v1/$ID.jpg" -o card.jpg && file card.jpg           # JPEG, 1200x630
```

The social-card cache header is diagnostic:

- `cache-control: public, max-age=31536000, immutable` means a real generated card was returned.
- `cache-control: public, max-age=60` means the static fallback card was returned because
  generation failed. The route deliberately returns HTTP 200 for an existing photo rather than
  making a crawler cache a missing card for days; the short TTL gives the next crawl a chance to
  retry. Investigate the Images binding, source object, or transformation cap, but the site is not
  down.

An unknown photo ID returns a real 404. That is intentional and is not covered by the never-error
rule for existing photos.

## 11. Troubleshooting

### **`No such module "node:async_hooks"`**

`compatibility_flags = ["nodejs_compat"]` is missing or was not deployed. Restore it in
`wrangler.toml`, rebuild, and rerun the deployment.

### **`Couldn't find a D1 DB named "img-gallery-preview"`**

The preview environment was omitted. Use
`pnpm exec wrangler d1 migrations apply img-gallery-preview --env preview --remote`; D1 bindings
are not inherited into named environments.

### **`NoSuchBucket` / "The specified bucket does not exist"**

Create the named bucket in the account from section 4 and confirm that
`[[env.preview.r2_buckets]]` exists for preview. R2 bindings are not inherited into named
environments, just like D1 bindings.

### **`Authentication error [code: 10000]`**

The token lacks the Edit permission for the resource the failing command touches, the
`CLOUDFLARE_ACCOUNT_ID` is wrong, or the token was rotated in Cloudflare but not in GitHub. Check
the account and zone scopes, then reset the repository secret.

### **Deploy uploads the Worker, then fails creating the route**

The token lacks **Workers Routes — Edit** for `takazudomodular.com`. Add that zone-scoped
permission and rerun the workflow; no application code change is needed.

### **A photo page loads but its `og:image` URL does not**

Compare the `og:image` origin with the active top-level `[[routes]]` pattern. `zfb.config.ts` uses
that hostname for absolute canonical and social metadata, so the matching custom-domain route must
be active before those published URLs can resolve. The production smoke now follows a real photo
link and fetches its declared JPEG to guard this contract.

### **Every page shows the 404 page in a browser while `curl` returns 200**

The path is missing from `assets.run_worker_first`. Reproduce with
`curl -H 'sec-fetch-mode: navigate'` and add both a collection root and its wildcard when needed;
`/tags/*` does not match bare `/tags`.

### **The site renders completely unstyled**

`dist/assets/app.css` is absent. The build's CSS-copy step asserts exactly one hashed stylesheet and
exits non-zero otherwise. Rerun `pnpm build` and read its output before deploying again.

### **`ERROR 9422` from the Images binding**

The monthly free transformation cap is exhausted. New transformations fail, while already
persisted cards keep serving. The `/og/*` route falls back to its static card at HTTP 200, so the
site stays up; check usage or wait for the next monthly allowance.

### **`gravity: "auto"` appears to be ignored locally**

Local `pnpm exec wrangler dev` implements only `width`, `height`, `rotate`, and `format` for the
Images binding. This is not an application bug; verify auto-gravity once against a deployed
preview.

### **`SEED_TAKAZUDO_PASSWORD is not set`**

Export the value in the shell using the interactive command in section 7. Do not commit it, put it
in a GitHub secret, or run `pnpm exec wrangler secret put` for it; the application never reads it.

### **The seeder re-uploads photos it already uploaded**

The seeder and `pnpm exec wrangler dev` are using different `--persist-to` directories, so the
resume query sees an empty database. Stop both processes, set `PERSIST=.wrangler/state`, run the
local migration, and restart the Worker and seeder with that same directory.

### **`SQLITE_BUSY` / a lock error during the backfill**

Stop `pnpm exec wrangler dev`, run the backfill, and restart the Worker for verification. Local D1
cannot run the backfill while the dev process owns the state lock.

### **The BlurHash backfill refuses remote mode**

Remote mode intentionally requires both `--d1 <database-name>` and `--bucket <bucket-name>` on
the same invocation. Add the exact names from the target environment; do not rely on the
production values in `wrangler.toml`. Wrangler must also be authenticated with D1 read/write and
R2 read permission for that account. Use `--dry-run` first and keep the resource names visible in
the operator log for the change record.

### **A BlurHash row failed or the summary reports conflicts**

The script does not update a row whose object is missing, oversized, undecodable, pixel-limited,
or timed out. It also retains the null predicate during a normal update, so a concurrent writer
can produce a conflict without being overwritten. Rerun the same bounded command after fixing the
specific object or resource; use `--force` only when deliberately replacing existing values. R2
objects are never changed by this workflow.

### **An upload is rejected as too large**

Uploads are capped at **4 MB**, enforced twice: an early `Content-Length` rejection and a definitive
post-parse check. Use the mirrored source files or a smaller upload.

### **A PR preview took over the custom domain**

Routes are inheritable. Restore `routes = []` under `[env.preview]`, keep the production `[[routes]]`
block above that header, and redeploy the affected preview and production Worker.

### **A compatibility-date error from `pnpm exec wrangler`**

If the command was actually run with a global Wrangler, its version may not understand the pinned
configuration. Run `pnpm install --frozen-lockfile` and use `pnpm exec wrangler` for every Wrangler
command so the exact project dependency is selected.

When the verification commands return the expected statuses, the D1 migrations are current, and a
seeded photo returns both an original and a social card, the gallery is ready for normal use.
