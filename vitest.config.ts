import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // zudo-react JSX for the .tsx files in the `ssr` project. Island and
  // ClientRouter import the zudo-react jsx-runtime themselves.
  esbuild: { jsx: "automatic", jsxImportSource: "@takazudo/zfb/zudo-react" },
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
          setupFiles: ["tests/helpers/island-build.ts"],
          include: ["tests/ssr/**/*.test.tsx"],
          exclude: ["e2e/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "handlers",
          environment: "node",
          setupFiles: ["tests/helpers/island-build.ts"],
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
