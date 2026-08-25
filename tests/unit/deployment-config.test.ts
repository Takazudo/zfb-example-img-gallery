import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wranglerConfig = readFileSync("wrangler.toml", "utf8");
const zfbConfig = readFileSync("zfb.config.ts", "utf8");

describe("production origin configuration", () => {
  it("keeps the canonical site on an active production-only custom domain", () => {
    const route = wranglerConfig.match(
      /^\[\[routes\]\]\s*\npattern\s*=\s*"([^"]+)"\s*\ncustom_domain\s*=\s*true\s*$/m,
    );
    const site = zfbConfig.match(/\bsite:\s*"([^"]+)"/);
    const previewHeader = wranglerConfig.match(/^\[env\.preview\]\s*$/m);

    expect(route?.[1]).toBeDefined();
    expect(site?.[1]).toBe(`https://${route?.[1]}`);
    expect(route?.index).toBeLessThan(previewHeader?.index ?? -1);
    expect(wranglerConfig).toMatch(/\[env\.preview\]\s*\nroutes\s*=\s*\[\]/);
  });

  it("routes both bare and child My Photos paths through the Worker", () => {
    expect(wranglerConfig).toMatch(/"\/my-photos", "\/my-photos\/\*"/);
  });

  it("routes both bare and child Favorites paths through the Worker", () => {
    expect(wranglerConfig).toMatch(/"\/favorites", "\/favorites\/\*"/);
  });

  it("keeps the favorites migration after the initial schema for fresh state", () => {
    const migrations = readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort();
    expect(migrations).toContain("0001_init.sql");
    expect(migrations).toContain("0002_favorites.sql");
    expect(migrations.indexOf("0002_favorites.sql")).toBeGreaterThan(migrations.indexOf("0001_init.sql"));
  });
});
