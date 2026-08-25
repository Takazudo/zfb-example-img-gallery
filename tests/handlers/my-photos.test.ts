import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import type { PhotoPurgeResult } from "../../lib/db/photo-purge";

const mocks = vi.hoisted(() => ({
  context: null as unknown as { env: Env; request: Request },
  getSessionUser: vi.fn(),
  listUserPhotoPage: vi.fn(),
  purgePhotos: vi.fn(),
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocks.context,
}));
vi.mock("../../lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("../../lib/db/photos", () => ({ listUserPhotoPage: mocks.listUserPhotoPage }));
vi.mock("../../lib/db/photo-purge", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db/photo-purge")>("../../lib/db/photo-purge");
  return { ...actual, purgePhotos: mocks.purgePhotos };
});

import MyPhotosPage from "../../pages/my-photos";

const user = { id: 7, username: "alice", email: "alice@example.test", avatar_key: null };

function makeDb(rows: Array<{ id: number; user_id: number; title: string }>): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const api = {
        bind(...next: unknown[]) {
          params = next;
          return api;
        },
        async all<T>() {
          if (!sql.toLowerCase().includes("select id, title")) return { results: [] as T[] };
          const owner = Number(params[0]);
          const ids = new Set(params.slice(1).map(Number));
          return {
            results: rows.filter((row) => row.user_id === owner && ids.has(row.id)) as T[],
          };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function request(
  method: string,
  body?: BodyInit,
  headers?: HeadersInit,
  path = "/my-photos",
): Request {
  const requestHeaders = new Headers(headers);
  return new Request(`https://example.test${path}`, { method, body, headers: requestHeaders });
}

async function invoke(req: Request, rows = [
  { id: 1, user_id: 7, title: "Sunset study" },
  { id: 2, user_id: 7, title: "Blue hour" },
  { id: 9, user_id: 8, title: "Foreign photo" },
]): Promise<Response> {
  mocks.context = {
    env: { DB: makeDb(rows) } as Env,
    request: req,
  };
  return MyPhotosPage();
}

function form(fields: Array<[string, string]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of fields) params.append(key, value);
  return params;
}

function json(body: unknown): string {
  return JSON.stringify(body);
}

beforeEach(() => {
  mocks.getSessionUser.mockReset();
  mocks.getSessionUser.mockResolvedValue(user);
  mocks.listUserPhotoPage.mockReset();
  mocks.purgePhotos.mockReset();
  mocks.purgePhotos.mockResolvedValue({ ok: true, deletedIds: [1] } satisfies PhotoPurgeResult);
});

describe("/my-photos handler", () => {
  it("rejects unsupported methods consistently", async () => {
    const response = await invoke(request("PUT"));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("renders a confirmation page on the first ordinary POST without purging", async () => {
    const response = await invoke(request(
      "POST",
      form([["photo_id", "1"], ["return_to", "/photos/1"]]),
    ));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Sunset study");
    expect(body).toContain("Delete permanently");
    expect(body).toContain('name="confirmed" value="1"');
    expect(body).toContain('name="photo_id" value="1"');
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("cancels without mutation and falls back from an unsafe return path", async () => {
    const response = await invoke(request(
      "POST",
      form([["photo_id", "1"], ["cancel", "1"], ["return_to", "https://evil.example/delete"]]),
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/my-photos");
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("bounds an otherwise safe return path before writing a Location header", async () => {
    const response = await invoke(request(
      "POST",
      form([["photo_id", "1"], ["cancel", "1"], ["return_to", `/${"a".repeat(2_049)}`]]),
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/my-photos");
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("deduplicates JSON ids, shares the owner purge path, and protects a deleted detail target", async () => {
    mocks.purgePhotos.mockResolvedValueOnce({ ok: true, deletedIds: [1] } satisfies PhotoPurgeResult);
    const response = await invoke(request(
      "POST",
      json({ photo_ids: ["1", 1], confirmed: true, return_to: "/photos/1?from=gallery" }),
      { "content-type": "application/json", accept: "application/json" },
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      deletedIds: [1],
      redirectTo: "/my-photos",
    });
    expect(mocks.purgePhotos).toHaveBeenCalledWith(mocks.context.env, 7, [1]);
  });

  it("returns a 303 for a confirmed ordinary form", async () => {
    const response = await invoke(request(
      "POST",
      form([["photo_id", "2"], ["confirmed", "1"], ["return_to", "/my-photos?page=2"]]),
    ));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/my-photos?page=2");
    expect(mocks.purgePhotos).toHaveBeenCalledWith(mocks.context.env, 7, [2]);
  });

  it("rejects the 101-entry boundary before ownership lookup or purge", async () => {
    const fields = Array.from({ length: 101 }, (_, index) => ["photo_id", String(index + 1)] as [string, string]);
    const response = await invoke(request("POST", form(fields)));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("No photos were deleted");
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("maps mixed-owner confirmation batches to one generic response", async () => {
    const response = await invoke(
      request("POST", form([["photo_id", "1"], ["photo_id", "9"]])),
    );
    const body = await response.text();
    expect(response.status).toBe(400);
    expect(body).toContain("No photos were deleted");
    expect(body).not.toContain("Foreign photo");
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it.each([
    ["r2-delete-failed", "R2 internals must not escape"],
    ["d1-delete-failed", "D1 internals must not escape"],
  ] as const)("maps %s purge failures to a retryable response", async (reason, internal) => {
    mocks.purgePhotos.mockResolvedValueOnce({ ok: false, reason } satisfies PhotoPurgeResult);
    const response = await invoke(request(
      "POST",
      form([["photo_id", "1"], ["confirmed", "1"]]),
    ));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain("Please try again");
    expect(body).not.toContain(internal);
  });

  it("rejects unreadable and oversized bodies before mutation", async () => {
    const malformed = await invoke(request(
      "POST",
      "not-json",
      { "content-type": "application/json", accept: "application/json" },
    ));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "We could not read that deletion request." });

    const oversized = await invoke(request(
      "POST",
      undefined,
      { "content-length": String(64 * 1024 + 1) },
    ));
    expect(oversized.status).toBe(413);
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("enforces the body limit when Content-Length is absent", async () => {
    const req = request(
      "POST",
      `photo_id=1&padding=${"x".repeat(64 * 1024)}`,
      { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    );
    expect(req.headers.get("content-length")).toBeNull();

    const response = await invoke(req);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "That deletion request is too large." });
    expect(mocks.purgePhotos).not.toHaveBeenCalled();
  });

  it("returns JSON 401 for an anonymous enhanced request", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    const response = await invoke(request(
      "POST",
      json({ photo_ids: [1], confirmed: true }),
      { "content-type": "application/json", accept: "application/json" },
    ));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Sign in to manage your photos.",
      login: "/login?next=%2Fmy-photos",
      loginUrl: "/login?next=%2Fmy-photos",
    });
  });

  it("preserves the requested My Photos page for anonymous login redirects", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    const response = await invoke(request("GET", undefined, undefined, "/my-photos/page/2?view=grid"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/login?next=%2Fmy-photos%2Fpage%2F2%3Fview%3Dgrid",
    );
    expect(mocks.listUserPhotoPage).not.toHaveBeenCalled();
  });
});
