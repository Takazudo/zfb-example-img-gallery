import { readFileSync } from "node:fs";
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
});
