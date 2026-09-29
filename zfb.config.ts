import { defineConfig } from "@takazudo/zfb/config";

const THEME_COLOR_ROLES = [
  "ink", "ink-soft", "ink-faint", "paper", "surface", "surface-sunken", "line", "line-strong",
  "brand", "brand-strong", "brand-soft", "accent", "success", "success-soft", "danger",
  "danger-soft", "on-brand", "on-danger",
] as const;

export default defineConfig({
  base: "/",
  // zudo-wind v1 has no implicit tokens. Every value points at an authored
  // custom property in styles/global.css, which stays the single source of
  // truth (the colour roles are re-bound per theme by html[data-theme]).
  wind: {
    spec: 1,
    reset: "owned-v1",
    tokens: {
      spacingUnit: "0.25rem",
      colors: Object.fromEntries(THEME_COLOR_ROLES.map((role) => [role, `var(--theme-${role})`])),
      spacing: {
        "hsp-2xs": "var(--spacing-hsp-2xs)",
        "hsp-xs": "var(--spacing-hsp-xs)",
        "hsp-sm": "var(--spacing-hsp-sm)",
        "hsp-md": "var(--spacing-hsp-md)",
        "hsp-lg": "var(--spacing-hsp-lg)",
        "hsp-xl": "var(--spacing-hsp-xl)",
        "vsp-2xs": "var(--spacing-vsp-2xs)",
        "vsp-xs": "var(--spacing-vsp-xs)",
        "vsp-sm": "var(--spacing-vsp-sm)",
        "vsp-md": "var(--spacing-vsp-md)",
        "vsp-lg": "var(--spacing-vsp-lg)",
        "vsp-xl": "var(--spacing-vsp-xl)",
        // Spacing tokens reject clamp() (ZW007), so the fluid gutter stays authored.
        gutter: "var(--gallery-gutter)",
      },
      fontSizes: {
        display: { size: "var(--text-display)", lineHeight: "var(--text-display--line-height)" },
        title: { size: "var(--text-title)", lineHeight: "var(--text-title--line-height)" },
        heading: { size: "var(--text-heading)", lineHeight: "var(--text-heading--line-height)" },
        body: { size: "var(--text-body)", lineHeight: "var(--text-body--line-height)" },
        small: { size: "var(--text-small)", lineHeight: "var(--text-small--line-height)" },
        micro: { size: "var(--text-micro)", lineHeight: "var(--text-micro--line-height)" },
      },
      fontWeights: { medium: "500", semibold: "600", bold: "700" },
      letterSpacings: { tight: "-0.025em", widest: "0.1em" },
      radii: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        pill: "var(--radius-pill)",
      },
      shadows: {
        card: "var(--shadow-card)",
        raised: "var(--shadow-raised)",
      },
    },
    // Only the prefixes the markup uses, at the Tailwind v4 thresholds it was built with.
    breakpoints: { sm: { minWidthPx: 640 }, md: { minWidthPx: 768 }, lg: { minWidthPx: 1024 } },
  },
  // Emits dist/_worker.js so `prerender = false` routes run as the Worker.
  adapter: "@takazudo/zfb-adapter-cloudflare",
  // Emitted as globalThis.__zfb.site — the single source of truth for absolute
  // canonical / OpenGraph URLs. Distinct from `base` (a sub-path mount prefix).
  site: "https://zfb-example-img-gallery.takazudomodular.com",
});
