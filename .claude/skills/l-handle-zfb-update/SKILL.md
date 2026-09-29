---
name: l-handle-zfb-update
description: >-
  Update the zfb upstream dependencies (@takazudo/zfb +
  @takazudo/zfb-adapter-cloudflare + @takazudo/zfb-runtime) to the latest
  stable "latest" dist-tag release, review the upstream changes between
  versions, and adapt this project's code if needed. Use when: (1) User says
  "update zfb", "bump zfb", "zfb update", or "handle zfb update", (2) A new
  zfb release is out and this image gallery example should track it.
user-invocable: true
argument-hint: "[target-version — omit to use latest]"
---

# Update the pinned zfb toolchain

This project keeps the three @takazudo/zfb* packages exact-pinned and in lockstep. The floor is the validated `3.0.0` (zudo-react runtime, zudo-wind styling; no Preact or Tailwind). A release can change the emitted Worker, the SSR router, the renderer, the class grammar, or the asset shape, so review upstream release notes before changing the lockfile.

## Step 0 — Preconditions

Check git status --short. package.json and pnpm-lock.yaml must both be clean. If either is modified, stop and ask the user to commit or stash it before continuing. Do not include unrelated working-tree changes in an upgrade.

## Step 1 — Resolve current and target versions

Read the current package value and the registry's stable target:

```bash
CURRENT=$(node -p "require('./package.json').dependencies['@takazudo/zfb']")
TARGET=$(npm view @takazudo/zfb dist-tags.latest)
```

Assert that @takazudo/zfb, @takazudo/zfb-adapter-cloudflare, and @takazudo/zfb-runtime all have the same bare version in package.json: no ^, no ~, and no range. Stop if they disagree. Always resolve the default target from the latest dist-tag, never next; an explicit argument to this skill overrides TARGET. Verify that the selected target exists for all three packages:

```bash
npm view "@takazudo/zfb-adapter-cloudflare@$TARGET" version
npm view "@takazudo/zfb-runtime@$TARGET" version
```

Stop if either package lacks the target. Never bump zfb ahead of its adapter: adapter skew can break the dist/_worker.js emission contract every SSR route depends on. Report and stop when CURRENT == TARGET. If the explicit target is older than CURRENT, treat it as a downgrade and ask for confirmation first.

## Step 1b — Major versions are migrations

If TARGET's major differs from CURRENT's, stop treating this as a version bump. The 2.15.0 to 3.0.0 move replaced the renderer, the CSS engine and the island runtime. Before touching the lockfile:

- Read the target's migration notes and the earlier recipes' write-ups, and plan the port as its own epic with a parity baseline captured on the current version first.
- Expect to add or rewrite tests, not just adapt code. The `ssr`, `handlers`, invariant and browser lanes must be green on the new major, and a test that used to fail must not be weakened to get there.
- Do the port on a base branch, verify with the side-by-side recipe in Step 5, and merge to main only when every gate passes (a merge to main deploys to production).

Only continue with the steps below for minor and patch bumps inside the same major.

## Step 2 — Review upstream changes before bumping

Enumerate every published zfb version between CURRENT (exclusive) and TARGET (inclusive). Use npm's publish order, not lexical sorting: next.9 and next.10 sort incorrectly as text.

```bash
node -e '
const vs = JSON.parse(process.argv[1]);
const cur = vs.indexOf(process.argv[2]), tgt = vs.indexOf(process.argv[3]);
if (tgt < 0) { console.error("target not found"); process.exit(1); }
if (cur >= 0 && tgt <= cur) { console.error("target is not newer than current"); process.exit(1); }
console.log(vs.slice(cur + 1, tgt + 1).join("\n"));
' "$(npm view @takazudo/zfb versions --json)" "$CURRENT" "$TARGET"
```

For every enumerated version, read both the release notes and the commit messages in the upstream comparison:

```bash
gh release view "v<version>" --repo Takazudo/zudo-front-builder --json body -q '.body'
gh api "repos/Takazudo/zudo-front-builder/compare/v<prev>...v<version>" \
  --jq '.commits[].commit.message' | head -40
```

Both commands must use the explicit upstream repo path shown above. Otherwise gh can fall back to this repository. Fail closed if the upstream changes cannot be reviewed; do not bump blind.

The upstream-surface → usage map for this repository is:

| Upstream surface | Where this project uses it |
| --- | --- |
| defineConfig schema (@takazudo/zfb/config) | zfb.config.ts: `wind` (see the next rows), adapter, and site. There is no `framework` or `tailwind` key any more. The site value is threaded into the bundle as globalThis.__zfb.site and read at request time for absolute canonical and og: URLs; changing that threading affects every social card. This project has no content collections because all content is in D1. |
| Cloudflare adapter (@takazudo/zfb-adapter-cloudflare) | getCloudflareContext<Env>() is imported by pages under pages/. The adapter emits dist/_worker.js and dist/_zfb_inner.mjs and must preserve the wrangler.toml contract: nodejs_compat, main, Static Assets, and the DB (D1), BUCKET (R2), and IMAGES (Cloudflare Images) bindings. |
| SSR page contract (prerender = false; a page returns a Response or a VNode) | Every file under pages/ except pages/404.tsx. A VNode gets <!doctype html> prepended automatically; lib/render.ts htmlResponse() is used when a route must set cookies, a 303, or a non-200 status. frontmatter is not required on a TSX page; a lone prerender = false is valid. |
| Dynamic route matching without paths() | pages/photos/[id].tsx, pages/tags/[tag]/..., pages/authors/[username]/..., pages/img/[...key].tsx, and pages/og/v1/[id].tsx. If a release reintroduces build-time enumeration for SSR routes, every clean URL in this project is affected. |
| export const contentType | pages/robots.txt.tsx and pages/sitemap.xml.tsx, which emit text and XML responses. |
| Static-asset serving and run_worker_first | wrangler.toml's explicit prefix array. A change in asset matching can reopen the navigation failure: browsers receive dist/404.html for an SSR route while curl without sec-fetch-mode: navigate still returns 200. |
| Prerendered-page emission | pages/404.tsx is the only prerendered page, and not_found_handling = "404-page" depends on dist/404.html. If SSG emission changes, the 404 page and Static Assets fallback need review. |
| zudo-wind config (`wind` in zfb.config.ts) | `spec: 1`, `reset: "owned-v1"`, explicit `tokens` (colors point at `var(--theme-*)`, spacing/fontSizes/radii/shadows at custom properties authored in styles/global.css), and `breakpoints` for `sm`/`md`/`lg`. v1 has no implicit tokens. Spacing tokens reject `clamp()` (ZW007), so the fluid gutter is authored. |
| zudo-wind class grammar | Rejected: attribute variants (`aria-[...]:`, `data-[...]:`) and arbitrary-selector variants (ZW004), `motion-safe:`/`motion-reduce:` (ZW002), and fractions like `left-1/2` (ZW005; use `left-[50%]`). Ordinary classes that emit nothing: `backdrop-blur`, `contents`, `not-sr-only`. Class names with `_` (BEM) fail with ZW001 (zudo-front-builder#3365) and authored names starting with a utility root such as `text-link` fail with ZW006 (#3389); both are reserved through `wind.authoredClasses`, which this app does not need today. Run `zfb wind explain <class>` before changing markup, and explain before reserving because explain reports "ordinary class" once a name is reserved. |
| owned-v1 reset and parity | owned-v1 is not Tailwind preflight (#3382). styles/global.css carries an authored `@layer base` parity block (only deltas a computed-style diff measured on elements this app renders) and unlayered rules for classes wind treats as ordinary (`.backdrop-blur`); wind appends its utilities after this file, so responsive overrides double their class. Re-diff computed styles after any bump. |
| Asset pipeline (`pnpm build`) | zfb emits dist/assets/styles-<hash>.css and islands-<hash>.js; `scripts/stable-assets.mjs` requires exactly one of each, normalizes absolute source paths in the client manifest to project-relative identifiers (symlinked checkouts included), re-hashes, rewrites the emitted HTML, and publishes `/assets/app.css` and `/assets/islands.js`; the layout links those stable names. `scripts/assert-ssr-invariants.mjs` then checks the inventory, the 404 markup and that the client manifest, 404 island markers and Worker SSR islands share identities and one build id. A failure there identifies an upstream emission change; debug the emitted files before changing either script. |
| zudo-react (@takazudo/zfb/zudo-react) | Provides `Child`, `rawHtml` (raw HTML via a `rawHtml` prop), `on:*` event props, `signal`/`computed`/`batch`/`Show`, `modelValue` group models for radios (a reactive `checked` passes types but throws ZR_MODEL_UNSUPPORTED, zudo-front-builder#3394) and `getScope()` (`{ abortSignal, onActivate, onCleanup, effect }`). Island identity is `displayName ?? name`. |
| Named server renderer | `renderToString` from `@takazudo/zfb/zudo-react/server`, used in lib/render.ts `htmlResponse()` (which prepends the doctype), lib/unlisted-attributes.ts and the `ssr` test project. |
| Unlisted attributes (zudo-front-builder#3359) | 3.0.0 throws ZR_ATTRIBUTE for `meta property`, `popover*`, `input form` and `img fetchpriority`. lib/unlisted-attributes.ts renders that static markup with `data-unlisted-*` placeholders and restores the names; the primary menu (which contains an island) is a `<site-popover>` custom element. When a release fixes #3359, remove the workaround and its tests. |
| Runtime page router, `Island` and `ClientRouter` (@takazudo/zfb-runtime, @takazudo/zfb) | The router is bundled into dist/_zfb_inner.mjs as the Worker fetch handler; every SSR route dispatches through it. The layout renders `ClientRouter` (soft navigation, view transitions, traverse refetch) and three islands ship client JS: `DisplaySettings`, `InfiniteGalleryControllerIsland` and `ThemeToggle`, each a signals + `getScope()` wrapper around a lib/ controller. Both are built on `@takazudo/zfb/zudo-react/jsx-runtime`. |
| CLI commands (zfb dev, zfb build, zfb preview, zfb check) | The dev, build, preview, and typecheck scripts in package.json; build also runs scripts/stable-assets.mjs. |
| Documented behaviour | README.md records commands, architecture, build output, and the upgrade pointer. TESTING.md records the Vitest project names and inner loop. Update both when an upgrade changes those facts. |

Adapt only if this project actually uses the changed feature. Content collections and Markdown/MDX processing are unused here; note such upstream changes in the report and move on.

## Step 3 — Bump all three packages

Use the project's package manager for the dependency change and npm only for registry metadata:

```bash
pnpm add -E "@takazudo/zfb@$TARGET" "@takazudo/zfb-adapter-cloudflare@$TARGET" "@takazudo/zfb-runtime@$TARGET"
```

-E preserves exact pins. All three packages must land on the same version. Commit package.json and pnpm-lock.yaml together because CI installs with --frozen-lockfile.

## Step 4 — Adapt project code

Apply only adaptations required by the reviewed upstream changes. Check the usage table above, the emitted Worker contract, the SSR route contract, and the wind/stable-asset contract. Update README.md and TESTING.md if commands, build output, or test-project behaviour changes. Do not add unused framework features just because an upstream release mentions them.

## Step 5 — Verify

Typecheck first, then remove generated output before building so stale files cannot mask an emission change. Limit cleanup to generated paths (dist, .zfb, and .zfb-build), then run the real project scripts:

```bash
pnpm typecheck
rm -rf dist .zfb .zfb-build
pnpm build
pnpm exec vitest run --project unit --project ssr --project handlers
node scripts/assert-ssr-invariants.mjs
```

Inspect the result:

- dist/_worker.js and dist/_zfb_inner.mjs exist.
- Exactly one dist/assets/styles-*.css exists and the build copied it to dist/assets/app.css; dist/assets/islands.js is byte-identical to the one generated islands-<hash>.js.
- dist/404.html exists and is the only HTML file.
- `pnpm why preact tailwindcss` stays empty.
- No stranded Tailwind entry temporary files remain (the `.gitignore` `zfb-tailwind-entry-*` guard is deliberately kept).
- A stable-assets or invariant failure identifies an upstream emission change; debug the emitted files before changing the scripts.

Browser and Worker checks (heavy; run through `bash $HOME/.claude/scripts/heavy-guard.sh -- <command>`, in the background):

- Use the isolated-state recipe in TESTING.md: migrations plus scripts/e2e-fixture.sql into an absolute scratch `--persist-to`, `wrangler dev` on explicit free ports (with `--inspector-port`), then `E2E_BASE_URL=http://127.0.0.1:<port> pnpm exec playwright test --grep @smoke` (that variable skips Playwright's webServer block).
- Never use `dev:cf:setup` for mutation tests, never `--remote`, never delete `.wrangler`, never touch production, and kill only your own servers by PID and port.
- For any bump that changes styling or rendering, compare a built baseline (previous version) and the candidate side by side on separate ports and separate scratch state, and diff HTTP output, island mounting and computed styles. The v3 migration's recipe scripts live in `$DROPBOX_CCLOGS_DIR/zfb-example-img-gallery/v3-migration/tools/` (`parity-run.sh`, `e2e-lane.sh`); do not rely on them being on other machines.
- Do not modernize Wrangler as part of a zfb bump (tracked upstream as zudo-front-builder#3357).

Recommend a binding-backed smoke check through the Wrangler loop: / should render the grid, /photos/<id> should render a detail page, and /og/v1/<id>.jpg should return a 1200x630 JPEG. env.DB, env.BUCKET, and env.IMAGES exist in that loop; a plain zfb dev server cannot validate those routes.

## Step 6 — Report

Report:

- The current and target versions and every version traversed.
- One line for each notable upstream change.
- Adaptations made, or "none needed".
- Build, typecheck, emitted-file, CSS, and binding-backed smoke results.
- Any feature reviewed but unused by this project.
