import { beforeEach } from "vitest";

/** zfb's build injects this scanner identity; `<Island>` refuses to render without it. */
export const TEST_ISLAND_BUILD = {
  zudoReactBuild: "vitest",
  zudoReactIslands: ["InfiniteGalleryControllerIsland", "DisplaySettings", "ThemeToggle"],
} as const;

beforeEach(() => {
  (globalThis as { __zfb?: object }).__zfb = { ...TEST_ISLAND_BUILD };
});
