import { render } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: {
    env: {} as never,
    request: new Request("https://foreign.example/"),
  },
  getSessionUser: vi.fn(),
  listPhotoPage: vi.fn(),
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocks.context,
}));
vi.mock("../../lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("../../lib/db/photos", () => ({
  PHOTO_PAGE_SIZE: 24,
  listPhotoPage: mocks.listPhotoPage,
}));

import TopPage from "../../pages/index";
import PhotoGridPage from "../../pages/page/[page]";

type PhotoItem = {
  id: number;
  title: string;
  r2_key: string;
  thumb_key: string | null;
  width: number;
  height: number;
};

function photo(id: number, overrides: Partial<PhotoItem> = {}): PhotoItem {
  return {
    id,
    title: `Photo ${id}`,
    r2_key: `photos/${id}.webp`,
    thumb_key: `photos/${id}.600.webp`,
    width: 1600,
    height: 1200,
    ...overrides,
  };
}

function page(items: PhotoItem[], totalItems: number, pageNumber = 1, totalPages = Math.max(1, Math.ceil(totalItems / 24))) {
  return { items, page: pageNumber, pageSize: 24, totalItems, totalPages, offset: (pageNumber - 1) * 24, hasPrev: pageNumber > 1, hasNext: pageNumber < totalPages };
}

const configuredGlobal = globalThis as { __zfb?: { site?: string } };

beforeEach(() => {
  mocks.context.request = new Request("https://foreign.example/");
  mocks.getSessionUser.mockResolvedValue(null);
  mocks.listPhotoPage.mockResolvedValue(page([], 0));
  configuredGlobal.__zfb = { site: "https://canonical.example" };
});

afterEach(() => {
  vi.clearAllMocks();
  delete configuredGlobal.__zfb;
});

describe("top page SSR", () => {
  it("renders an empty state without a grid or pager and links signed-out visitors to registration", async () => {
    const html = render(await TopPage());

    expect(html).toContain("<h1");
    expect(html).toContain("No photos yet");
    expect(html).toContain('href="/register"');
    expect(html).not.toContain('data-testid="photo-grid"');
    expect(html).not.toContain('aria-label="Pagination"');
  });

  it("uses the signed-in upload next step for an empty gallery", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, username: "alice", email: "alice@example.com", avatar_key: null });

    const html = render(await TopPage());

    expect(html).toContain("@alice");
    expect(html).toContain('href="/upload"');
    expect(html).not.toContain('data-testid="photo-grid"');
  });

  it.each([
    [24, 1, false],
    [25, 2, true],
  ])("renders %i photos as %i page(s) and hides the pager only for one page", async (totalItems, totalPages, hasPager) => {
    mocks.listPhotoPage.mockResolvedValue(page([photo(1)], totalItems, 1, totalPages));

    const html = render(await TopPage());

    expect(html).toContain('data-testid="photo-grid"');
    expect(html.includes('aria-label="Pagination"')).toBe(hasPager);
  });

  it("uses thumbnails with original dimensions and makes only the first tile eager", async () => {
    mocks.listPhotoPage.mockResolvedValue(page([
      photo(1),
      photo(2, { thumb_key: null, width: 900, height: 1400 }),
    ], 2));

    const html = render(await TopPage());

    expect(html).toContain('src="/img/photos/1.600.webp"');
    expect(html).toContain('src="/img/photos/2.webp"');
    expect(html).toContain('alt="Photo 1"');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="1200"');
    expect(html).toContain('width="900"');
    expect(html).toContain('height="1400"');
    expect(html).toContain('loading="eager"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it("maps page-one and later pager links to their canonical paths", async () => {
    mocks.listPhotoPage.mockResolvedValue(page([photo(1)], 25, 1, 2));

    const html = render(await TopPage());

    expect(html).toContain('href="/"');
    expect(html).toContain('href="/page/2"');
    expect(html).not.toContain('href="/page/1"');
  });
});

describe("dynamic top page SSR", () => {
  it("renders the effective last page and canonicalizes an out-of-range request", async () => {
    mocks.context.request = new Request("https://foreign.example/page/999?preview=1");
    mocks.listPhotoPage.mockResolvedValue(page([photo(73)], 73, 3, 3));

    const html = render(await PhotoGridPage({ params: { page: "999" } }));

    expect(html).toContain("Photo 73");
    expect(html).toContain('href="https://canonical.example/page/3"');
    expect(html).toMatch(/<a href="\/page\/3"[^>]*aria-current="page"/);
    expect(html).not.toContain('href="https://foreign.example/page/999"');
  });

  it.each(["abc", "-3"])('renders malformed segment %j as page 1 with the root canonical', async (raw) => {
    mocks.context.request = new Request(`https://foreign.example/page/${raw}`);
    mocks.listPhotoPage.mockResolvedValue(page([photo(1)], 1, 1, 1));

    const html = render(await PhotoGridPage({ params: { page: raw } }));

    expect(html).toContain("Photo 1");
    expect(html).toContain('href="https://canonical.example/"');
    expect(html).not.toContain(`/page/${raw}`);
  });
});
