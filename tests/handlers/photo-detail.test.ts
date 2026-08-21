import { runWithCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import PhotoDetailPage from "../../pages/photos/[id]";

function mockEnv(found: boolean) {
  const prepare = vi.fn((sql: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => found ? {
        id: 7,
        user_id: 3,
        title: "Found photo",
        description: "A description.",
        r2_key: "photos/found.webp",
        thumb_key: null,
        content_type: "image/webp",
        width: 1200,
        height: 800,
        blurhash: null,
        created_at: "2026-08-20 01:02:03",
        author_id: 3,
        author_username: "alice",
        author_avatar_key: null,
      } : null),
      all: vi.fn(async () => ({
        results: sql.includes("FROM photo_tags") ? [] : [],
      })),
    };
    return statement;
  });
  const env = Object.assign(Object.create(null), { DB: { prepare } }) as Env;
  return { env, prepare };
}

function invoke(env: Env, id: string): Promise<Response> {
  return runWithCloudflareContext(
    {
      env,
      ctx: { waitUntil() {}, passThroughOnException() {} },
      request: new Request(`https://gallery.example/photos/${encodeURIComponent(id)}`),
    },
    () => PhotoDetailPage({ params: { id } }),
  );
}

describe("photo detail handler", () => {
  it("returns 404 for an unknown valid id", async () => {
    const { env, prepare } = mockEnv(false);
    const response = await invoke(env, "7");
    expect(response.status).toBe(404);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each(["abc", "0", "-1", "1.5", "99999999999999999999"])(
    "rejects malformed id %s before querying D1",
    async (id) => {
      const { env, prepare } = mockEnv(false);
      const response = await invoke(env, id);
      expect(response.status).toBe(404);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("returns an HTML 200 for a found photo", async () => {
    const { env } = mockEnv(true);
    const response = await invoke(env, "7");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
