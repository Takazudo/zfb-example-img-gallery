import { defineConfig, devices } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// The e2e suite runs against a real `wrangler dev`, which serves the BUILT
// output — so `pnpm build` must have run first. Fail here with a readable
// message instead of letting every spec time out against a 404.
if (!existsSync("dist/_worker.js")) {
  throw new Error("dist/_worker.js is missing — run `pnpm build` before `playwright test`.");
}

const PORT = 8788;
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// One pinned persistence directory for BOTH the migration step and the dev
// server. Wrangler's local D1/R2 state is per-directory; letting the two
// commands pick different defaults produces an app whose tables do not exist.
const PERSIST = ".wrangler/state";
const wranglerToml = readFileSync("wrangler.toml", "utf8");
const topLevelToml = wranglerToml.split(/^\[env\./m, 1)[0];
const D1_NAME = topLevelToml.match(/^\[\[d1_databases\]\][\s\S]*?^\s*database_name\s*=\s*"([^"]+)"/m)?.[1];
if (!D1_NAME) {
  throw new Error("Could not find the top-level database_name in wrangler.toml.");
}

export default defineConfig({
  testDir: "./e2e",
  // One worker: a single local wrangler dev backed by one D1 file. Parallel
  // workers would interleave writes into shared pagination and tag pages.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command:
          `pnpm exec wrangler d1 migrations apply ${D1_NAME} --local --persist-to ${PERSIST} --env="" && ` +
          `pnpm exec wrangler d1 execute ${D1_NAME} --local --persist-to ${PERSIST} --env="" --file scripts/e2e-fixture.sql && ` +
          `pnpm exec wrangler dev --env="" --port ${PORT} --persist-to ${PERSIST}`,
        url: `${BASE_URL}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
