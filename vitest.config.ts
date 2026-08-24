import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Preact JSX for the .tsx files in the `ssr` project.
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  // zfb applies these aliases in production. Mirror them so the framework-
  // neutral Island and ClientRouter packages mint Preact VNodes in SSR tests.
  resolve: {
    alias: {
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
    },
  },
  ssr: {
    noExternal: ["@takazudo/zfb", "@takazudo/zfb-runtime"],
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          exclude: ["e2e/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "ssr",
          environment: "node",
          include: ["tests/ssr/**/*.test.tsx"],
          exclude: ["e2e/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "handlers",
          environment: "node",
          include: ["tests/handlers/**/*.test.ts"],
          exclude: ["e2e/**"],
        },
      },
      {
        extends: true,
        // Runs inside the real Workers runtime with this repo's bindings.
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["e2e/**"],
        },
      },
    ],
  },
});
