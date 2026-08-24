# Cloudflare Images binding capability probe

This is the observed capability report for issue 79. It uses the real high-fidelity Images
binding through a temporary Worker, not Miniflare's low-fidelity local implementation.

## Probe conditions

- Date: 2026-08-25 (the remote preview log timestamps are 2026-08-24 UTC).
- Wrangler: `4.85.0`, the version pinned in `package.json`.
- Binding: `env.IMAGES`, account `367c7f51801e1f537030f93d5a5e6008`.
- Remote command: `pnpm exec wrangler dev --remote --config probe-wrangler.toml --port 8799 --ip 127.0.0.1`.
- Lifecycle bound by `timeout --signal=INT --kill-after=15s 150s node probe-orchestrator.mjs`;
  the orchestrator sent SIGINT in `finally` after collecting the responses.
- No remote preview was left running after the probe.
- Responses were PNGs decoded to raw pixels with `sharp` for dimensions, channel count, alpha,
  and coordinate checks.

The temporary Worker accepted fixture PNGs as multipart form fields. Unless noted otherwise, the
source fixtures were deliberately tiny and flat-color so a transformed pixel could be identified
without visual guesswork:

- `red4x2`: opaque red 4 × 2 source.
- `black8x8`: opaque black 8 × 8 draw layer.
- `white8x8`: opaque white 8 × 8 backdrop; `red2x2`: opaque red 2 × 2 draw layer.
- `blurSource`: transparent 10 × 10 canvas with an opaque red 4 × 4 square at `(3,3)`.

## Results

| Probe | Outcome | Observed result |
| --- | --- | --- |
| `fit: "pad"` + transparent background | **works** | 200; 8 × 8 PNG with 4 channels; 32 opaque red pixels and 32 fully transparent pixels. |
| `draw(blackFill, { composite: "in" })` | **works** | 200; 8 × 8 PNG with 4 channels; the padded surround is `(0,0,0,0)` and the former image area is opaque black `(0,0,0,255)`. |
| transparent `border` | **works** | 200; 10 × 8 PNG; the 4 × 2 red content remains 4 × 2 at x=3..6, y=3..4, while all three-pixel-per-side border areas are transparent. |
| `blur: 3` through alpha | **works** | 200; 10 × 10 PNG with 4 channels. Every pixel has partial alpha (minimum non-zero alpha 1, maximum 137); the transparent-canvas corner is `(1,0,0,1)`, outside the source square `(75,0,0,75)`, and the square center `(137,0,0,137)`. The blur is alpha-aware and spreads into the surrounding transparent area. |
| absolute draw offsets + opacity | **works** | 200; with `left: 2`, `top: 3`, `opacity: 0.5`, only x=2..3/y=3..4 changes from white to `(255,128,128)`; adjacent checked pixels remain `(255,255,255)`. |
| separate-input transformer as draw argument and transformer reuse | **behaves differently** | A transformer made by a separate `input()` can be passed to `draw` and succeeds. Reusing that same transformer for a second draw fails with Images error 9525 (`ImageTransformer consumed; you may only call .output() or draw a transformer once`). Each draw/output branch must use a fresh input transformer. |

### 1. Transparent pad

Exact call:

```ts
await env.IMAGES.input(sourceStream).transform({
  width: 8,
  height: 8,
  fit: "pad",
  background: "transparent",
}).output({ format: "image/png" });
```

The 4 × 2 red source became an 8 × 8 image. Raw output had four channels; pixels at `(0,0)`
and `(4,0)` were `(0,0,0,0)`, while pixels at `(0,4)` and `(4,4)` were `(255,0,0,255)`.
This confirms a real alpha channel rather than a flattened opaque background.

### 2. Black silhouette with `composite: "in"`

Exact calls:

```ts
const backdrop = env.IMAGES.input(sourceStream).transform({
  width: 8,
  height: 8,
  fit: "pad",
  background: "transparent",
});
await backdrop.draw(
  env.IMAGES.input(blackFillStream),
  { composite: "in" },
).output({ format: "image/png" });
```

The output retained the pad's transparent surround (including `(0,0)` and `(4,0)`) and changed
the opaque source area to black with alpha 255. This is the required black silhouette shape.

### 3. Border expands the canvas without rescaling

Exact call:

```ts
await env.IMAGES.input(sourceStream).transform({
  border: { color: "rgba(0,0,0,0)", width: 3 },
}).output({ format: "image/png" });
```

The output was 10 × 8, exactly 3 pixels wider on both sides and 3 pixels taller on both sides.
The original 4 × 2 red pixels were still 4 × 2 at x=3..6/y=3..4; `(0,0)` was transparent.
This expands the canvas and does not upscale the content.

### 4. Blur spreads through alpha

Exact call:

```ts
await env.IMAGES.input(blurSourceStream)
  .transform({ blur: 3 })
  .output({ format: "image/png" });
```

The transparent 10 × 10 canvas made the outward spread measurable without relying on a second
transform. All 100 output pixels had partial alpha. The source square's edges were no longer
hard-clamped: alpha reached the surrounding transparent pixels, including the corner. The
returned raw samples carried RGB proportional to alpha (`(75,0,0,75)` outside the square), so
the result is usable as a soft transparent glow.

### 5. Absolute offsets and opacity

Exact call:

```ts
await env.IMAGES.input(whiteBackdropStream).draw(
  env.IMAGES.input(red2x2Stream),
  { left: 2, top: 3, opacity: 0.5 },
).output({ format: "image/png" });
```

The 2 × 2 layer occupied exactly x=2..3/y=3..4. The top-left and center samples in that region
were `(255,128,128)`, while `(1,2)` immediately before the layer and `(4,5)` immediately after
it stayed `(255,255,255)`. Both absolute offsets and 0.5 opacity were honored.

### 6. Separate transformer draw and reuse

Separate-input draw call:

```ts
const separate = env.IMAGES.input(overlayStream).transform({ width: 2, height: 2 });
await env.IMAGES.input(whiteBackdropStream)
  .draw(separate, { left: 2, top: 3 })
  .output({ format: "image/png" });
```

This returned 200 and placed the red 2 × 2 layer exactly at x=2..3/y=3..4, proving that a
transformer built from a separate `input()` is accepted as a draw argument.

Reuse call:

```ts
const reusable = env.IMAGES.input(overlayStream).transform({ width: 2, height: 2 });
await env.IMAGES.input(whiteBackdropStream)
  .draw(reusable, { left: 0, top: 0 })
  .output({ format: "image/png" });
await env.IMAGES.input(whiteBackdropStream)
  .draw(reusable, { left: 6, top: 6 })
  .output({ format: "image/png" });
```

The first output succeeded (200, 8 × 8). The second failed with:

```text
IMAGES_TRANSFORM_ERROR 9525: ImageTransformer consumed; you may only call .output() or draw a transformer once
```

The transformer is therefore single-use once it has been drawn/output. Do not reuse one
transformer across branches; create a fresh `input()` transformer for each branch.

## Output artifacts

The raw PNG outputs are retained outside the worktree for optional visual inspection:

`/home/takazudo/cclogs/takazudo-zfb-example-img-gallery/20260825-issue-76/artifacts/79/`

It contains `pad.png`, `composite-in.png`, `border.png`, `blur.png`, `layered.png`,
`separate-draw.png`, and `reuse-first.png`.
