# Testing

## Archetype and tiers

This project follows the **Monorepo App + Functions Backend** archetype. Levels describe what a test can see; tiers describe where and when it runs:

- **T0** is the fast inner loop for a topic-sized change.
- **T1** is the pull-request gate.
- **L1** sees pure functions, **L3** sees a rendered page or handler with stubbed bindings, and **L4** sees real Worker-runtime storage or SQL semantics.

The structural delta is deliberate: this checkout is a single-package repository, not a monorepo. Workspace-splitting guidance therefore collapses to one package with four Vitest projects.

## What runs where

The project names and file globs below are copied from vitest.config.ts.

| Project | Level | Tier | File glob | What it covers |
| --- | --- | --- | --- | --- |
| unit | L1 | T0/T1 | tests/unit/**/*.test.ts | Pure functions and artifact scanners: domain helpers plus prerender/runtime inventory and stable-asset failure modes. |
| ssr | L3 | T0/T1 | tests/ssr/**/*.test.tsx | preact-render-to-string over page components: markup contracts, dynamic head/runtime structure, theme/router policy, JSON-LD, and empty-state rendering. |
| handlers | L3 | T0/T1 | tests/handlers/**/*.test.ts | Route handlers against stubbed bindings (a mock R2 exposing its own store and stub D1): status codes, redirects, cache headers, cookie flags, and error paths. |
| integration | L4 | T1 | tests/integration/**/*.test.ts | Miniflare/Workers runtime only where storage or SQL semantics are genuinely the subject: R2 put → get, the ordered favorites migration/read model, and R2-first/D1-batch photo purge behavior. |

The mandatory topic-worker command selects unit, ssr, and handlers. pnpm test:all also runs the integration project.

The fresh-state D1 contract applies `migrations/0001_init.sql` and then
`migrations/0002_favorites.sql` in the Workers runtime before exercising the
two-user count/membership and deletion-cascade seams:

```sh
pnpm exec vitest run --project integration tests/integration/favorites.integration.test.ts tests/integration/photo-purge.integration.test.ts
```

### Legacy BlurHash backfill

The operator workflow is covered by the Node unit fixture in
`tests/unit/backfill-blurhash.test.ts`. It uses generated temporary image bytes and fake D1/R2
adapters, and exercises remote-resource enforcement, cursor/null-row paging, `--limit`, Sharp
object/download/pixel bounds, fixed-4x4 output, concurrency, isolated failures, dry-run zero
mutation, conditional versus forced SQL, partial retries, and an idempotent second run. Run the
focused check with:

```sh
pnpm exec vitest run --project unit tests/unit/backfill-blurhash.test.ts
```

The test suite does not invoke Wrangler against a remote account, deploy, or mutate production.
The runbook's local commands use a temporary or explicitly shared `--persist-to` directory; a
remote command must name both D1 and R2 resources and should be dry-run first under operator
control. Automated tests never run the remote backfill. A separate operator run completed the
production legacy-data backfill on 2026-08-24: 294 hashes present, zero missing or malformed, and
an immediate normal rerun selected zero rows.

### Browser lane

The `@smoke` Playwright lane runs one Chromium worker against one shared local Wrangler state. `playwright.config.ts` applies migrations and the idempotent `scripts/e2e-fixture.sql` before starting the server. The fixture creates one `e2e-fixture` author/tag and 50 lightweight rows with deterministic mixed dimensions; every `/img/**` request is intercepted with test PNG bytes, so no R2 upload is needed and repeated setup is safe.

The browser confirmation covers the existing register → login → upload → detail/tag/social-card journey plus the complete progressive gallery contract: delayed loading, exactly 24 + 24 + a smaller final remainder, one canonical grid whose real cards are followed directly by loading tiles, five-column/six-card geometry and computed-gap checks, terminal status, one controlled error with retry and untouched link/grid, observer construction/observation fallbacks, observer anti-cascade, deduplication against an existing card, patterned layouts and responsive widths, all Display settings ratios/widths, computed mixed-dimension Original cards, invalid/deleted storage defaults, reload and cross-tab persistence, zfb soft-navigation persistence, newly appended cards, two-batch router navigation + Back restoration with a no-reload sentinel, a JavaScript-disabled canonical link, and manual loading with IntersectionObserver unavailable. `e2e/photo-management.spec.ts` adds one serial two-user journey: a safe requested login path, four uploaded photos, count-versus-viewer membership, an authenticated Favorites collection add/remove read, thumbnail/detail favorite synchronization, identical outline/filled star geometry, appended-card add/remove controls, owner/non-owner delete presentation, single and bulk Escape/click cancellation plus confirmation, an ordinary no-JavaScript confirmation page, stale Back/forward reconciliation, exactly-one JSON mutation probes, focus restoration, polite live regions, 44px-class target and overflow checks at 375/800/1200, normal toast transition timing, and reduced-motion zero-translation/instant timing. Theme, navigation, form, auth/header, title/meta, route-announcer, and accessibility assertions remain in the existing smoke specs; signed-in header controls are asserted after `ensureAccountMenuOpen`, and `e2e/header-nav.spec.ts` carries the single `@smoke` core header case.

The exact local command is:

```sh
bash $HOME/.claude/scripts/playwright-guard.sh --wait 300 -- pnpm exec playwright test --grep @smoke
```

The guard owns the one server lifecycle; do not start a second unmanaged dev server. The spec intercepts outbound image requests with a 1×1 PNG by default and uses tiny generated PNGs only when it must verify intrinsic mixed dimensions. `.github/workflows/deploy.yml` runs the same lane before deployment and uploads Playwright diagnostics when the job fails or is cancelled. `scripts/smoke.mjs` provides the separate post-deploy production check.

The exact guarded command for the integrated photo-management journey is:

```sh
bash $HOME/.claude/scripts/playwright-guard.sh --wait 300 -- pnpm exec playwright test e2e/photo-management.spec.ts --grep @smoke
```

Do not report its browser results from a topic worker; the manager runs it after the branch is merged into the integrated base. The no-JavaScript path uses the same one-server Playwright configuration and the ordinary canonical links/forms; route handlers additionally cover the confirmation-page contract.

### SSR invariants

These are the invariants that can fail silently and belong in the build/integration checks:

- Every page except pages/404.tsx exports the literal prerender = false.
- dist/404.html is the only HTML file emitted by the build.
- The client artifact inventory is exactly one generated islands entry, its reachable generated chunks/resources, and the byte-identical stable `/assets/islands.js` alias. An unrelated JavaScript artifact fails the scan.
- `scripts/stable-assets.mjs` normalizes source-module diagnostics to portable project-relative identifiers before hashing the finalized bytes. The generated entry filename must be `islands-<first-eight-sha256-hex>.js`, and the scanner recomputes that digest from the final bytes rather than trusting a pre-normalization name.
- Every client JavaScript asset reachable from that finalized entry is inspected for leaked absolute POSIX paths, Windows-drive paths, or `file:` source-module diagnostics. Ordinary web paths and URLs remain valid. The entry must retain `components/display-settings.tsx`, `components/infinite-gallery-controller.tsx`, and `components/theme-toggle.tsx`.
- `dist/404.html` has the marked pre-paint bootstrap, router meta/style output, theme island marker, and one injected hashed module entry, with no stable-module duplicate or arbitrary executable script. JSON-LD remains non-executable structured data.
- The SSG module reference must name the finalized reachable entry exactly; stale, dangling, or stable `/assets/islands.js` references fail. The stable alias remains byte-identical to the generated entry.
- Dynamic `GalleryLayout` documents have the bootstrap before `/assets/app.css`, the router policy/announcer, theme island, and exactly one stable module entry. The SSG layout mode suppresses that stable tag so zfb can inject its hashed entry.
- A navigation-header (sec-fetch-mode: navigate) request against every bare collection root in run_worker_first — /, /authors, /tags, /favorites, and /my-photos — is answered by the Worker, not by dist/404.html. This is the failure that looks fine to curl and is broken for real browser navigation.

`scripts/assert-ssr-invariants.mjs` checks the source and built-output invariants. The test suite also covers collection-root navigation headers through the Worker entry point.

The browser confirmation lane must also preserve progressive enhancement: active navigation, auth/header controls, title/meta, and server-rendered page content update after soft navigation; `data-theme` survives swaps; GET and mutation forms preserve query, multipart, URL-encoded, redirect, validation, error, cookie, and submitter behavior; disabling JavaScript still performs normal full form navigations. `zfb:after-swap` fires before incoming scripts and before newly swapped islands mount/hydrate, so it must not be used as a hydration-ready signal.

### BlurHash Worker-to-browser contract

The local Images binding is exercised with three real, decodable fixtures (JPEG,
PNG, and WebP). The integration test runs `preprocessAndStorePhoto` through the
Workers runtime, checks a canonical fixed-4×4 hash in a D1 contract table, and
compares the R2 body and content type with the original upload. Run it after the
build because the Workers Vitest project loads `dist/_worker.js`:

```sh
pnpm build
pnpm exec vitest run --project integration
```

The focused browser additions are in `e2e/blurhash.spec.ts`. The manager should
run them through the repository guard (which owns the one local Wrangler server):

```sh
bash $HOME/.claude/scripts/playwright-guard.sh --wait 300 -- pnpm exec playwright test e2e/blurhash.spec.ts --grep @smoke
```

That lane covers delayed pending-to-loaded and error reveals, nullable rows,
cover/contain pseudo-backgrounds, reduced-motion duration, appended cards,
history snapshot restoration, no-JavaScript visibility, and the executable
script/inline-handler inventory. The local fixture intentionally has no R2
objects; browser `/img/**` requests are intercepted with deterministic bytes.

### High-fidelity Images verification (manual, credential-gated)

Local Images simulation does not establish Cloudflare's network-specific
decoding/cropping behavior. When credentials and Images entitlement are
available, create isolated preview-only D1 and R2 resources (never the
production `img-gallery` resources), apply the migration, and run the preview
Worker against that temporary configuration:

```sh
pnpm exec wrangler d1 migrations apply <isolated-preview-d1> --remote
pnpm exec wrangler dev --remote --config <isolated-preview-wrangler.toml> --port 8789
```

Upload one JPEG, PNG, and WebP through `http://127.0.0.1:8789/upload`, verify
the D1 hash is either canonical fixed-4×4 or the documented nullable fallback,
and download each `/img/**` object to compare bytes and `Content-Type`. Stop
the remote dev process, delete every fixture row, object, and isolated preview
resource (`wrangler d1 delete` / `wrangler r2 bucket delete`) in a finally/cleanup
step. If credentials, entitlement, or isolated resources are unavailable, this
is a deferred manual check rather than a local automated failure. This preview
check remains separate from the completed production legacy-data backfill noted above.

## Deliberate deltas

- **T0 + T1 only.** There is no T2 end-to-end split and no T3 scheduled re-exam; nothing in this standalone recipe is heavy or registry-coupled enough to earn either tier.
- **Miniflare is scoped, not default.** Use the real Worker runtime for storage and SQL semantics only. Everything else uses stubs because booting a Worker runtime per test file is an order of magnitude slower than the inner-loop budget.
- **Exactly one computed-style check per layout-owning surface.** CSS correctness cannot be established by unit tests. The integrated browser journey has assertions for the card/My Photos surface and detail actions at 375, 800, and 1200 pixels. For the reserved L5 dump, the manager should use one guarded invocation per URL/selector and record the JSON results. The example gallery/detail URLs are public; owner-only presentation remains authoritative in the integrated Playwright assertion because this verifier has no session-cookie export:

  ```sh
  node $HOME/.claude/skills/verify-ui/scripts/verify-styles.mjs "http://127.0.0.1:8788/" ".photo-card" "$PWD/test-results/verify-card" "375,800,1200" "light" "load"
  node $HOME/.claude/skills/verify-ui/scripts/verify-styles.mjs "http://127.0.0.1:8788/photos/<PHOTO_ID>" "[data-photo-detail-actions]" "$PWD/test-results/verify-detail" "375,800,1200" "light" "load"
  ```

  Replace `<PHOTO_ID>` with an uploaded fixture id in the manager's authenticated browser context. The `photo-management.spec.ts` computed-style assertions must remain in the guarded serial lane; this verifier is deliberately not committed as a separate regression gate.
- **A test script exists here.** The upstream toolchain's internal examples/ rule forbids that workspace's recursive test lane; it does not apply to this standalone recipe repository.
- **gravity: "auto" is not asserted locally.** Local wrangler dev implements only width, height, rotate, and format of the Images binding. Local assertions cover exact output dimensions and content type; salient-band cropping is verified once against a deployed preview.

## Agent rules

Automated agents working in this repository must follow these rules:

1. **The mandatory inner loop is exactly two commands, and it must be green before any hand-off:**

   ```sh
   pnpm exec tsc --noEmit
   pnpm exec vitest run --project unit --project ssr --project handlers
   ```

2. **Do not launch a browser from a parallel worker.** Several agents may run concurrently; simultaneous browser boots thrash the machine. Heavy end-to-end verification, the full suite, and long builds belong to the integration pass and CI, never to a per-topic worker.
3. **Unit tests cannot prove visual correctness.** For CSS, layout, or responsive behaviour, a passing suite is not evidence. Use the one reserved computed-style invocation described above for the two layout-owning surfaces.
4. **Never claim a browser-level result you did not run.** Name the command that produced each browser claim.
5. **Never suggest clearing a browser cache or hard-refreshing as a fix.** If something still renders incorrectly, the code is still wrong.
6. **New tests go in the project matching their level.** A route-handler test belongs in handlers, not unit, even when it happens to be fast.

## What is deliberately not tested

- No visual-regression baseline.
- No load testing.
- No assertion that gravity: "auto" selected the correct salient band.
- No full 293-item seeding-script run; a bounded sample is the appropriate smoke test.
- No coverage-threshold gate.

### Pagination boundary exercised by browser tests

The deterministic fixture makes the two full-page transitions and final remainder repeatable, but it does not change the production pagination contract. Pages use offset pagination, so a concurrent insert between page requests can shift a later offset and omit one row (or produce a duplicate). The client deduplicates repeated photo IDs while appending; it cannot recover an omitted row, and cursor pagination is outside this feature.
