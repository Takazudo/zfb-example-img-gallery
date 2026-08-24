# Brand assets

Build-time inputs for `scripts/make-brand-assets.mjs`. Nothing here is served directly —
the script rasterises these into `public/`.

## `takazudo-mark.svg`

The Takazudo mark, used on the composed OG social card (`public/og-plate.png`).

`fill` is baked to `#ffffff` rather than left as `currentColor`: sharp has no CSS context and
renders `currentColor` as black, which would silently vanish against the `#141210` card plate.
