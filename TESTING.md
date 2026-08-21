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
| unit | L1 | T0/T1 | tests/unit/**/*.test.ts | Pure functions: pagination page-count/offset math, tag normalisation, image-header dimension parsing, slug/taxonomy parsing, password-hashing helpers, storage-key rules, and SEO helpers. |
| ssr | L3 | T0/T1 | tests/ssr/**/*.test.tsx | preact-render-to-string over page components: markup contracts, the head tag set with absolute URLs, the JSON-LD block, and empty-state rendering. |
| handlers | L3 | T0/T1 | tests/handlers/**/*.test.ts | Route handlers against stubbed bindings (a mock R2 exposing its own store and stub D1): status codes, redirects, cache headers, cookie flags, and error paths. |
| integration | L4 | T1 | tests/integration/**/*.test.ts | Miniflare/Workers runtime only where storage or SQL semantics are genuinely the subject: currently an R2 put → get round trip, with migration and Images-binding assertions belonging here when those seams are exercised. |

The mandatory topic-worker command selects unit, ssr, and handlers. pnpm test:all also runs the integration project.

### Browser lane

The intended browser lane is one @smoke Playwright spec in CI:

register → login → upload → photo appears on page 1 → detail page → tag page lists it → the detail page's og:image URL returns 200 with image/jpeg.

CI should intercept outbound image requests with a 1×1 PNG. Failure artefacts should be uploaded on failure() || cancelled().

TODO: e2e/, playwright.config.ts, and scripts/smoke.mjs are not present in this checkout yet, so no browser-level result may be claimed until the integration work adds and runs that lane.

### SSR invariants

These are the invariants that can fail silently and belong in the build/integration checks:

- Every page except pages/404.tsx exports the literal prerender = false.
- dist/404.html is the only HTML file emitted by the build.
- No client-JS bundle and no <script> tag ships.
- A navigation-header (sec-fetch-mode: navigate) request against every bare collection root in run_worker_first — /, /authors, and /tags — is answered by the Worker, not by dist/404.html. This is the failure that looks fine to curl and is broken for real browser navigation.

TODO: the current checkout has no browser/integration assertion script for these deployment-level invariants; add it with the pending integration lane.

## Deliberate deltas

- **T0 + T1 only.** There is no T2 end-to-end split and no T3 scheduled re-exam; nothing in this standalone recipe is heavy or registry-coupled enough to earn either tier.
- **Miniflare is scoped, not default.** Use the real Worker runtime for storage and SQL semantics only. Everything else uses stubs because booting a Worker runtime per test file is an order of magnitude slower than the inner-loop budget.
- **Exactly one computed-style check per layout-owning surface.** CSS correctness cannot be established by unit tests. The design-system work and the detail page should each run one verify-styles.mjs computed-style invocation at 375, 800, and 1200 pixels: one URL, one selector, all breakpoints, one invocation. This is not a general Playwright suite.
- TODO: verify-styles.mjs is not present in this checkout yet. Until it lands, do not claim that the computed-style check has run.
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
