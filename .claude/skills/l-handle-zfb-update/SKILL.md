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

This project keeps the three @takazudo/zfb* packages exact-pinned and in lockstep. A release can change the emitted Worker, the SSR router, or the stylesheet shape, so review upstream release notes before changing the lockfile.

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
| defineConfig schema (@takazudo/zfb/config) | zfb.config.ts: framework: "preact", tailwind.enabled, adapter, and site. The site value is threaded into the bundle as globalThis.__zfb.site and read at request time for absolute canonical and og: URLs; changing that threading affects every social card. This project has no content collections because all content is in D1. |
| Cloudflare adapter (@takazudo/zfb-adapter-cloudflare) | getCloudflareContext<Env>() is imported by pages under pages/. The adapter emits dist/_worker.js and dist/_zfb_inner.mjs and must preserve the wrangler.toml contract: nodejs_compat, main, Static Assets, and the DB (D1), BUCKET (R2), and IMAGES (Cloudflare Images) bindings. |
| SSR page contract (prerender = false; a page returns a Response or a VNode) | Every file under pages/ except pages/404.tsx. A VNode gets <!doctype html> prepended automatically; lib/render.ts htmlResponse() is used when a route must set cookies, a 303, or a non-200 status. frontmatter is not required on a TSX page; a lone prerender = false is valid. |
| Dynamic route matching without paths() | pages/photos/[id].tsx, pages/tags/[tag]/..., pages/authors/[username]/..., pages/img/[...key].tsx, and pages/og/v1/[id].tsx. If a release reintroduces build-time enumeration for SSR routes, every clean URL in this project is affected. |
| export const contentType | pages/robots.txt.tsx and pages/sitemap.xml.tsx, which emit text and XML responses. |
| Static-asset serving and run_worker_first | wrangler.toml's explicit prefix array. A change in asset matching can reopen the navigation failure: browsers receive dist/404.html for an SSR route while curl without sec-fetch-mode: navigate still returns 200. |
| Prerendered-page emission | pages/404.tsx is the only prerendered page, and not_found_handling = "404-page" depends on dist/404.html. If SSG emission changes, the 404 page and Static Assets fallback need review. |
| Tailwind and CSS pipeline | styles/global.css uses Tailwind v4; zfb emits dist/assets/styles-<hash>.css; scripts/stable-css.mjs asserts exactly one match and copies it to assets/app.css; the layout hard-codes that path. If zfb starts injecting a stylesheet link into SSR output, the hard-coded link becomes a duplicate and the stable-css step can be removed only after verification. |
| Runtime page router (@takazudo/zfb-runtime) | Bundled into dist/_zfb_inner.mjs as the Worker fetch handler; every SSR route dispatches through it. Islands and client-router features are unused: this project ships zero client JS. |
| CLI commands (zfb dev, zfb build, zfb preview, zfb check) | The dev, build, preview, and typecheck scripts in package.json; build also runs scripts/stable-css.mjs. |
| Documented behaviour | README.md records commands, architecture, build output, and the upgrade pointer. TESTING.md records the Vitest project names and inner loop. Update both when an upgrade changes those facts. |

Adapt only if this project actually uses the changed feature. Content collections, Markdown/MDX processing, islands, the client router, and frameworks other than Preact are unused here; note such upstream changes in the report and move on.

## Step 3 — Bump all three packages

Use the project's package manager for the dependency change and npm only for registry metadata:

```bash
pnpm add -E "@takazudo/zfb@$TARGET" "@takazudo/zfb-adapter-cloudflare@$TARGET" "@takazudo/zfb-runtime@$TARGET"
```

-E preserves exact pins. All three packages must land on the same version. Commit package.json and pnpm-lock.yaml together because CI installs with --frozen-lockfile.

## Step 4 — Adapt project code

Apply only adaptations required by the reviewed upstream changes. Check the usage table above, the emitted Worker contract, the SSR route contract, and the CSS/stable-name contract. Update README.md and TESTING.md if commands, build output, or test-project behaviour changes. Do not add unused framework features just because an upstream release mentions them.

## Step 5 — Verify

Remove generated output before building so stale files cannot mask an emission change. Limit cleanup to generated paths (dist, .zfb, and .zfb-build), then run the real project scripts:

```bash
rm -rf dist .zfb .zfb-build
pnpm build
pnpm typecheck
```

Inspect the result:

- dist/_worker.js and dist/_zfb_inner.mjs exist.
- Exactly one dist/assets/styles-*.css exists and the build copied it to dist/assets/app.css.
- dist/404.html exists and is the only HTML file.
- No stranded Tailwind entry temporary files remain.
- A stable-css failure identifies an upstream CSS-emission change; debug the emitted CSS before changing the copy script.

Recommend a binding-backed smoke check through the Wrangler loop: / should render the grid, /photos/<id> should render a detail page, and /og/v1/<id>.jpg should return a 1200x630 JPEG. env.DB, env.BUCKET, and env.IMAGES exist in that loop; a plain zfb dev server cannot validate those routes.

## Step 6 — Report

Report:

- The current and target versions and every version traversed.
- One line for each notable upstream change.
- Adaptations made, or "none needed".
- Build, typecheck, emitted-file, CSS, and binding-backed smoke results.
- Any feature reviewed but unused by this project.
