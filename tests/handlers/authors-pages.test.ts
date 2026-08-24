import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorProfile } from "../../lib/db/authors";
import type { Env } from "../../lib/env";
import type { AuthorSummary, PhotoCard } from "../../lib/types";

const mocked = vi.hoisted(() => ({
  current: null as null | { env: Env; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => mocked.current,
}));

import AuthorsPage from "../../pages/authors/index";
import AuthorDetailPage from "../../pages/authors/[username]/index";
import AuthorDetailPagedPage from "../../pages/authors/[username]/page/[page]";

interface DbRows {
  authors?: AuthorSummary[];
  author?: AuthorProfile[];
  counts?: number[];
  photos?: PhotoCard[];
}

/** A substring-dispatched D1 stub: handlers are tested without Miniflare. */
function makeDb(rows: DbRows = {}): D1Database {
  const authors = rows.authors ?? [];
  const author = rows.author ?? [];
  const counts = [...(rows.counts ?? [0])];
  const photos = rows.photos ?? [];

  return {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").toUpperCase();
      let params: unknown[] = [];
      const api = {
        bind(...next: unknown[]) {
          params = next;
          return api;
        },
        async all<T>() {
          if (normalized.includes("GROUP BY U.ID")) {
            return { results: authors as T[] };
          }
          if (normalized.includes("ORDER BY CREATED_AT DESC, ID DESC")) {
            const limit = typeof params[1] === "number" ? params[1] : photos.length;
            const offset = typeof params[2] === "number" ? params[2] : 0;
            return { results: photos.slice(offset, offset + limit) as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (normalized.includes("COLLATE NOCASE")) return (author[0] ?? null) as T | null;
          if (normalized.includes("COUNT(*) AS N")) return ({ n: counts.shift() ?? 0 } as T);
          return null;
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

const alice: AuthorProfile = {
  id: 1,
  username: "alice",
  avatar_key: null,
  created_at: "2026-08-20T00:00:00.000Z",
};

function photo(id: number): PhotoCard {
  return {
    id,
    title: `photo-${id}`,
    r2_key: `photos/${id}.jpg`,
    thumb_key: id % 2 === 0 ? `thumbs/${id}.webp` : null,
    width: 1600,
    height: 1200,
    blurhash: null,
  };
}

function setContext(path: string, rows: DbRows) {
  mocked.current = {
    env: { DB: makeDb(rows) } as unknown as Env,
    request: new Request(`https://example.test${path}`),
  };
}

async function body(response: Response): Promise<string> {
  return response.text();
}

beforeEach(() => {
  mocked.current = null;
});

describe("author page handlers", () => {
  it("renders two qualifying authors and their pluralised counts", async () => {
    setContext("/authors", {
      authors: [
        { id: 1, username: "alice", avatar_key: null, photo_count: 1 },
        { id: 2, username: "bob", avatar_key: "avatars/bob.webp", photo_count: 12 },
      ],
    });

    const response = await AuthorsPage();
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("@alice");
    expect(html).toContain("1 photo");
    expect(html).toContain("@bob");
    expect(html).toContain("12 photos");
  });

  it("renders the empty list state at HTTP 200", async () => {
    setContext("/authors", { authors: [] });

    const response = await AuthorsPage();
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("No authors yet");
    expect(html).toContain('href="/register"');
    expect(response.status).not.toBe(404);
  });

  it("renders a known author's first page with at most the page-size tiles", async () => {
    setContext("/authors/alice", { author: [alice], counts: [3], photos: [photo(1), photo(2), photo(3)] });

    const response = await AuthorDetailPage({ params: { username: "alice" } });
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("<h1 class=\"text-display font-semibold tracking-tight\">@alice</h1>");
    expect((html.match(/href="\/photos\//g) ?? []).length).toBeLessThanOrEqual(24);
    expect(html).toContain('src="/img/photos/1.jpg"');
    expect(html).toContain('loading="eager"');
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).toContain("data-theme-bootstrap");
    expect(html).toContain('type="module" src="/assets/islands.js"');
  });

  it("keeps author feed metadata sequential through a full and remainder batch", async () => {
    const photos = Array.from({ length: 49 }, (_, index) => photo(index + 1));

    setContext("/authors/alice", { author: [alice], counts: [49], photos });
    const first = await body(await AuthorDetailPage({ params: { username: "alice" } }));
    expect(first).toContain('data-gallery-scope="author:1"');
    expect(first).toContain('data-gallery-page="1"');
    expect(first).toContain('data-gallery-total-pages="3"');
    expect(first).toContain('data-gallery-total-items="49"');
    expect(first).toContain('data-gallery-page-size="24"');
    expect(first).toContain('data-gallery-next-url="/authors/alice/page/2"');
    expect(first).toContain('data-gallery-next-count="24"');
    expect(first).toContain(">Load next 24 photos</a>");

    setContext("/authors/alice/page/2", { author: [alice], counts: [49], photos });
    const middle = await body(await AuthorDetailPagedPage({ params: { username: "alice", page: "2" } }));
    expect(middle).toContain('data-gallery-page="2"');
    expect(middle).toContain('data-gallery-next-url="/authors/alice/page/3"');
    expect(middle).toContain('data-gallery-next-count="1"');
    expect(middle).toContain(">Load next 1 photos</a>");
    expect(middle).toContain('loading="lazy"');

    setContext("/authors/alice/page/3", { author: [alice], counts: [49], photos });
    const final = await body(await AuthorDetailPagedPage({ params: { username: "alice", page: "3" } }));
    expect(final).toContain('data-gallery-page="3"');
    expect(final).toContain('data-gallery-terminal="true"');
    expect(final).not.toContain('data-gallery-next-link="true"');
    expect(final).not.toContain('loading="eager"');
  });

  it("returns a layout-wrapped 404 for an unknown username", async () => {
    setContext("/authors/UNKNOWN", { author: [] });

    const response = await AuthorDetailPage({ params: { username: "UNKNOWN" } });
    const html = await body(response);
    expect(response.status).toBe(404);
    expect(html).toContain("Author not found");
    expect(html).toContain('href="/authors"');
  });

  it("renders the stored casing after a case-insensitive lookup", async () => {
    setContext("/authors/ALICE", { author: [alice], counts: [1], photos: [photo(1)] });

    const response = await AuthorDetailPage({ params: { username: "ALICE" } });
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("@alice");
    expect(html).not.toContain("@ALICE");
  });

  it("keeps an existing author with no photos at HTTP 200 without pagination", async () => {
    setContext("/authors/alice", { author: [alice], counts: [0], photos: [] });

    const response = await AuthorDetailPage({ params: { username: "alice" } });
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("No photos yet");
    expect(html).not.toContain('aria-label="Pagination"');
    expect(html).toContain('data-gallery-scope="author:1"');
    expect(html).toContain('data-gallery-terminal="true"');
  });

  it("clamps an overflowing page to the final tile", async () => {
    setContext("/authors/alice/page/9999", {
      author: [alice],
      counts: [25],
      photos: Array.from({ length: 25 }, (_, index) => photo(index + 1)),
    });

    const response = await AuthorDetailPagedPage({ params: { username: "alice", page: "9999" } });
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("photo-25");
    expect(html).not.toContain("photo-1");
    expect(html).toContain('data-gallery-page="2"');
    expect(html).toContain('data-gallery-terminal="true"');
  });

  it("treats a non-numeric page as page 1", async () => {
    setContext("/authors/alice/page/abc", {
      author: [alice],
      counts: [25],
      photos: Array.from({ length: 25 }, (_, index) => photo(index + 1)),
    });

    const response = await AuthorDetailPagedPage({ params: { username: "alice", page: "abc" } });
    const html = await body(response);
    expect(response.status).toBe(200);
    expect(html).toContain("photo-1");
    expect(html).not.toContain('href="/authors/alice/page/1"');
    expect(html).toContain('data-gallery-page="1"');
  });
});
