import { render } from "preact-render-to-string";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";

const h = vi.hoisted(() => ({
  context: null as unknown as { env: Env; request: Request },
  sessionUser: null as unknown as {
    id: number;
    username: string;
    email: string;
    avatar_key: string | null;
  } | null,
  listFavoritePage: vi.fn(),
  setFavoriteState: vi.fn(),
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.context,
}));
vi.mock("../../lib/auth", () => ({
  getSessionUser: vi.fn(async () => h.sessionUser),
}));
vi.mock("../../lib/db/favorites", () => ({
  countUserFavorites: vi.fn(),
  listFavoritePage: h.listFavoritePage,
  setFavoriteState: h.setFavoriteState,
}));

import FavoritesPage from "../../pages/favorites/index";
import FavoritesPagedPage from "../../pages/favorites/page/[page]";

const user = {
  id: 7,
  username: "alice",
  email: "alice@example.com",
  avatar_key: null,
};

const photo = {
  id: 9,
  user_id: 4,
  title: "A favorite",
  r2_key: "photos/9.jpg",
  thumb_key: "thumbs/9.jpg",
  width: 1200,
  height: 800,
  blurhash: null,
  is_favorited: true,
};

function page(overrides: Record<string, unknown> = {}) {
  return {
    page: 1,
    pageSize: 24,
    totalItems: 1,
    totalPages: 1,
    offset: 0,
    hasPrev: false,
    hasNext: false,
    items: [photo],
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://gallery.example${path}`, init);
}

async function invoke(
  route: () => Promise<unknown>,
  path: string,
  init: RequestInit = {},
): Promise<Response | string> {
  h.context = { env: { DB: {} } as Env, request: request(path, init) };
  const result = await route();
  if (result instanceof Response) return result;
  return render(result as never);
}

beforeEach(() => {
  h.sessionUser = user;
  h.listFavoritePage.mockReset();
  h.listFavoritePage.mockResolvedValue(page());
  h.setFavoriteState.mockReset();
  h.setFavoriteState.mockResolvedValue({ photoId: 9, favorited: true, favoriteCount: 3 });
});

describe("Favorites collection routes", () => {
  it("requires auth for both the root and child GET routes", async () => {
    h.sessionUser = null;
    const root = await invoke(FavoritesPage, "/favorites");
    expect(root).toBeInstanceOf(Response);
    expect((root as Response).status).toBe(303);
    expect((root as Response).headers.get("location")).toBe("/login?next=%2Ffavorites");

    const child = await invoke(
      () => FavoritesPagedPage({ params: { page: "2" } }),
      "/favorites/page/2",
    );
    expect(child).toBeInstanceOf(Response);
    expect((child as Response).headers.get("location")).toBe("/login?next=%2Ffavorites%2Fpage%2F2");
  });

  it("renders the signed-in collection with viewer scope, metadata, SEO, and active nav", async () => {
    h.listFavoritePage.mockResolvedValue(page({ totalItems: 49, totalPages: 3, hasNext: true }));
    const result = await invoke(FavoritesPage, "/favorites");
    expect(typeof result).toBe("string");
    const html = result as string;
    expect(html).toContain("Favorites");
    expect(html).toContain('data-gallery-scope="favorites:7|viewer:7"');
    expect(html).toContain('data-gallery-page="1"');
    expect(html).toContain('data-gallery-total-items="49"');
    expect(html).toContain('data-gallery-next-url="/favorites/page/2"');
    expect(html).toContain('href="/favorites" aria-current="page"');
    expect(html).toContain('rel="canonical"');
    expect(html).toContain("https://gallery.example/favorites");
    expect(h.listFavoritePage).toHaveBeenCalledWith(expect.anything(), 7, 1, 7);
  });

  it("uses the clamped page returned by D1 for a later canonical route", async () => {
    h.listFavoritePage.mockResolvedValue(page({ page: 3, totalItems: 49, totalPages: 3, hasPrev: true }));
    const result = await invoke(
      () => FavoritesPagedPage({ params: { page: "999" } }),
      "/favorites/page/999",
    );
    const html = result as string;
    expect(html).toContain('data-gallery-page="3"');
    expect(html).toContain("https://gallery.example/favorites/page/3");
    expect(h.listFavoritePage).toHaveBeenCalledWith(expect.anything(), 7, 999, 7);
  });

  it("keeps POST root-only and rejects unsupported methods", async () => {
    const response = await invoke(FavoritesPage, "/favorites", { method: "PUT" });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(405);
    expect((response as Response).headers.get("allow")).toBe("GET, POST");

    const child = await invoke(
      () => FavoritesPagedPage({ params: { page: "2" } }),
      "/favorites/page/2",
      { method: "POST" },
    );
    expect((child as Response).status).toBe(405);
  });
});

describe("Favorites mutation negotiation", () => {
  function jsonPost(body: unknown, headers: HeadersInit = {}): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    };
  }

  it("returns the authoritative favorite DTO as same-origin JSON", async () => {
    const response = await invoke(
      FavoritesPage,
      "/favorites",
      jsonPost({ photoId: 9, state: "favorited" }),
    );
    expect(response).toBeInstanceOf(Response);
    const actual = response as Response;
    expect(actual.status).toBe(200);
    expect(actual.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await actual.json()).toEqual({ photoId: 9, favorited: true, favoriteCount: 3 });
    expect(h.setFavoriteState).toHaveBeenCalledWith(expect.anything(), 7, 9, "favorited");
  });

  it("keeps ordinary forms on the 303 contract and validates the return path", async () => {
    const fields = new URLSearchParams({ photoId: "9", state: "unfavorited", return_to: "/photos/9" });
    const response = await invoke(FavoritesPage, "/favorites", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields,
    });
    expect((response as Response).status).toBe(303);
    expect((response as Response).headers.get("location")).toBe("/photos/9");
    expect(h.setFavoriteState).toHaveBeenCalledWith(expect.anything(), 7, 9, "unfavorited");

    const unsafe = await invoke(
      FavoritesPage,
      "/favorites",
      jsonPost({ photoId: 9, state: "favorited", return_to: "https://evil.example/" }),
    );
    expect((unsafe as Response).status).toBe(400);
    expect(await (unsafe as Response).json()).toEqual({ error: "return_to must be a safe relative path." });
    expect(h.setFavoriteState).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed input, missing photos, and oversized bodies", async () => {
    const missingId = await invoke(FavoritesPage, "/favorites", jsonPost({ state: "favorited" }));
    expect((missingId as Response).status).toBe(400);

    const badState = await invoke(FavoritesPage, "/favorites", jsonPost({ photoId: 9, state: "toggle" }));
    expect((badState as Response).status).toBe(400);

    h.setFavoriteState.mockResolvedValueOnce(null);
    const missingPhoto = await invoke(FavoritesPage, "/favorites", jsonPost({ photoId: 404, state: "favorited" }));
    expect((missingPhoto as Response).status).toBe(404);

    const oversized = await invoke(FavoritesPage, "/favorites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": "16385",
      },
      body: "{}",
    });
    expect((oversized as Response).status).toBe(413);
    expect(h.setFavoriteState).toHaveBeenCalledTimes(1);
  });

  it("returns JSON 401 or a login redirect for anonymous mutation requests", async () => {
    h.sessionUser = null;
    const json = await invoke(
      FavoritesPage,
      "/favorites",
      jsonPost({ photoId: 9, state: "favorited", return_to: "/photos/9" }),
    );
    expect((json as Response).status).toBe(401);
    expect(await (json as Response).json()).toMatchObject({
      error: "Authentication required.",
      login: "/login?next=%2Fphotos%2F9",
    });

    const form = new URLSearchParams({ photoId: "9", state: "favorited", return_to: "/photos/9" });
    const redirectResponse = await invoke(FavoritesPage, "/favorites", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect((redirectResponse as Response).status).toBe(303);
    expect((redirectResponse as Response).headers.get("location")).toBe("/login?next=%2Fphotos%2F9");
    expect(h.setFavoriteState).not.toHaveBeenCalled();
  });
});
