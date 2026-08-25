import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: {
    env: {} as never,
    request: new Request("https://foreign.example/my-photos"),
  },
  getSessionUser: vi.fn(),
  listUserPhotoPage: vi.fn(),
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocks.context,
}));
vi.mock("../../lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("../../lib/db/photos", () => ({ PHOTO_PAGE_SIZE: 24, listUserPhotoPage: mocks.listUserPhotoPage }));

import MyPhotosPage from "../../pages/my-photos";
import MyPhotosPagedPage from "../../pages/my-photos/page/[page]";

type Item = {
  id: number;
  user_id: number;
  title: string;
  r2_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
  blurhash: string | null;
  is_favorited: boolean;
};

function photo(id: number, userId = 7): Item {
  return {
    id,
    user_id: userId,
    title: `Photo ${id}`,
    r2_key: `photos/${id}.jpg`,
    thumb_key: `thumbs/${id}.jpg`,
    width: 1600,
    height: 1200,
    blurhash: null,
    is_favorited: false,
  };
}

function page(items: Item[], totalItems: number, pageNumber = 1, totalPages = Math.max(1, Math.ceil(totalItems / 24))) {
  return {
    items,
    page: pageNumber,
    pageSize: 24,
    totalItems,
    totalPages,
    offset: (pageNumber - 1) * 24,
    hasPrev: pageNumber > 1,
    hasNext: pageNumber < totalPages,
  };
}

const user = { id: 7, username: "alice", email: "alice@example.test", avatar_key: null };
const configuredGlobal = globalThis as { __zfb?: { site?: string } };

async function html(response: Response): Promise<string> {
  return response.text();
}

beforeEach(() => {
  mocks.getSessionUser.mockClear();
  mocks.listUserPhotoPage.mockClear();
  mocks.context.request = new Request("https://foreign.example/my-photos");
  mocks.getSessionUser.mockResolvedValue(user);
  mocks.listUserPhotoPage.mockResolvedValue(page([], 0));
  configuredGlobal.__zfb = { site: "https://canonical.example" };
});

describe("My Photos collection SSR", () => {
  it("redirects anonymous visitors before reading the personal feed", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    const response = await MyPhotosPage();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(mocks.listUserPhotoPage).not.toHaveBeenCalled();
  });

  it("renders an authenticated empty state with a personal scope and Upload action", async () => {
    const response = await MyPhotosPage();
    const body = await html(response);
    expect(response.status).toBe(200);
    expect(body).toContain("My Photos");
    expect(body).toContain("No photos yet");
    expect(body).toContain('href="/upload"');
    expect(body).toContain('data-gallery-scope="my-photos:7"');
    expect(body).toContain('data-gallery-terminal="true"');
    expect(mocks.listUserPhotoPage).toHaveBeenCalledWith(mocks.context.env, 7, 1, 7);
  });

  it("keeps only the authenticated user's cards and canonicalizes child pages", async () => {
    const items = Array.from({ length: 24 }, (_, index) => photo(index + 25));
    mocks.context.request = new Request("https://foreign.example/my-photos/page/2?from=bad");
    mocks.listUserPhotoPage.mockResolvedValueOnce(page(items, 49, 2, 3));

    const body = await html(await MyPhotosPagedPage({ params: { page: "2" } }));
    expect(body).toContain('data-gallery-scope="my-photos:7"');
    expect(body).toContain('data-gallery-page="2"');
    expect(body).toContain('data-gallery-total-items="49"');
    expect(body).toContain('href="/my-photos/page/3"');
    expect(body).toContain('href="https://canonical.example/my-photos/page/2"');
    expect(body).not.toContain('href="https://foreign.example/my-photos/page/2?from=bad"');
    expect(mocks.listUserPhotoPage).toHaveBeenCalledWith(mocks.context.env, 7, 2, 7);
  });

  it("clamps a final page and keeps the empty state free of a next link", async () => {
    mocks.context.request = new Request("https://foreign.example/my-photos/page/999");
    mocks.listUserPhotoPage.mockResolvedValueOnce(page([photo(49)], 49, 3, 3));
    const body = await html(await MyPhotosPagedPage({ params: { page: "999" } }));
    expect(body).toContain("Photo 49");
    expect(body).toContain('data-gallery-page="3"');
    expect(body).toContain('data-gallery-terminal="true"');
    expect(body).not.toContain('data-gallery-next-link="true"');
    expect(body).toContain('href="https://canonical.example/my-photos/page/3"');
  });
});
