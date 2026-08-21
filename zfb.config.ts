import { defineConfig } from "@takazudo/zfb/config";

export default defineConfig({
  framework: "preact",
  base: "/",
  // The v4 compiler is embedded in the zfb binary; there is no npm tailwindcss.
  tailwind: { enabled: true },
  // Emits dist/_worker.js so `prerender = false` routes run as the Worker.
  adapter: "@takazudo/zfb-adapter-cloudflare",
  // Emitted as globalThis.__zfb.site — the single source of truth for absolute
  // canonical / OpenGraph URLs. Distinct from `base` (a sub-path mount prefix).
  site: "https://zfb-example-img-gallery.takazudomodular.com",
});
