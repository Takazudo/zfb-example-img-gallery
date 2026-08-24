import { render } from "preact-render-to-string";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctx: null as unknown as { env: unknown; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.ctx,
}));

import TagsPage from "../../pages/tags";
import TagDetailPage, { type TagRouteResult } from "../../pages/tags/[tag]/index";
import type { Env } from "../../lib/env";

type Row = Record<string, unknown>;
type MockStatement = {
  bind: (...values: unknown[]) => MockStatement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
};

type MockDbOptions = {
  tag?: Row | null;
  total?: number;
  photos?: Row[];
  tags?: Row[];
};

function mockDb(options: MockDbOptions = {}) {
  const bound: unknown[][] = [];
  const db = {
    prepare(sql: string): MockStatement {
      const lowered = sql.toLowerCase();
      const statement: MockStatement = {
        bind(...values) {
          bound.push(values);
          return statement;
        },
        async all<T>() {
          if (lowered.includes("from photos p")) return { results: (options.photos ?? []) as T[] };
          if (lowered.includes("from tags t")) return { results: (options.tags ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (lowered.includes("select id, name from tags")) return (options.tag ?? null) as T | null;
          if (lowered.includes("count(*) as n")) return { n: options.total ?? 0 } as T;
          return null;
        },
      };
      return statement;
    },
    bound,
  };
  return db;
}

function envWith(db: ReturnType<typeof mockDb>): Env {
  return { DB: db } as unknown as Env;
}

function request(path: string): Request {
  return new Request(`https://gallery.example${path}`);
}

async function invoke(
  page: (props?: { params?: { tag?: string; page?: string } }) => Promise<TagRouteResult>,
  path: string,
  params: { tag?: string; page?: string } | undefined,
  db: ReturnType<typeof mockDb>,
): Promise<{ status: number; body: string }> {
  h.ctx = { env: envWith(db), request: request(path) };
  const result = await page({ params });
  if (result instanceof Response) return { status: result.status, body: await result.text() };
  return { status: 200, body: render(result) };
}

beforeEach(() => {
  h.ctx = null as unknown as { env: unknown; request: Request };
});

describe("tag route handlers", () => {
  const photo = {
    id: 7,
    title: "A tagged photo",
    r2_key: "photos/7.jpg",
    thumb_key: "thumbs/7.jpg",
    width: 1200,
    height: 800,
    created_at: "2026-08-20 01:02:03",
    username: "alice",
  };

  it("returns 404 for an unknown tag", async () => {
    const result = await invoke(TagDetailPage, "/tags/missing", { tag: "missing" }, mockDb());
    expect(result.status).toBe(404);
  });

  it("returns 404 when the decoded route segment cannot be normalised", async () => {
    const result = await invoke(TagDetailPage, "/tags/a%2Fb", { tag: "a/b" }, mockDb());
    expect(result.status).toBe(404);
  });

  it("renders a known tag as a successful SSR response", async () => {
    const result = await invoke(
      TagDetailPage,
      "/tags/Foo",
      { tag: "Foo" },
      mockDb({ tag: { id: 3, name: "foo" }, total: 1, photos: [photo] }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain("#foo");
    expect(result.body).toContain('href="/photos/7"');
  });

  it("keeps tag feed metadata sequential through a full and remainder batch", async () => {
    const options = {
      tag: { id: 3, name: "foo" },
      total: 49,
      photos: [photo],
    };
    const first = await invoke(TagDetailPage, "/tags/foo", { tag: "foo" }, mockDb(options));
    expect(first.body).toContain('data-gallery-scope="tag:3"');
    expect(first.body).toContain('data-gallery-page="1"');
    expect(first.body).toContain('data-gallery-total-pages="3"');
    expect(first.body).toContain('data-gallery-total-items="49"');
    expect(first.body).toContain('data-gallery-page-size="24"');
    expect(first.body).toContain('data-gallery-next-url="/tags/foo/page/2"');
    expect(first.body).toContain('data-gallery-next-count="24"');
    expect(first.body).toContain(">Load next 24 photos</a>");

    const middle = await invoke(TagDetailPage, "/tags/foo/page/2", { tag: "foo", page: "2" }, mockDb(options));
    expect(middle.body).toContain('data-gallery-page="2"');
    expect(middle.body).toContain('data-gallery-next-url="/tags/foo/page/3"');
    expect(middle.body).toContain('data-gallery-next-count="1"');
    expect(middle.body).toContain(">Load next 1 photos</a>");

    const final = await invoke(TagDetailPage, "/tags/foo/page/3", { tag: "foo", page: "3" }, mockDb(options));
    expect(final.body).toContain('data-gallery-page="3"');
    expect(final.body).toContain('data-gallery-terminal="true"');
    expect(final.body).not.toContain('data-gallery-next-link="true"');
    expect(final.body).not.toContain('loading="eager"');
  });

  it("clamps an out-of-range page to the last page and stays successful", async () => {
    const db = mockDb({ tag: { id: 3, name: "foo" }, total: 1, photos: [photo] });
    const result = await invoke(
      TagDetailPage,
      "/tags/foo/page/999",
      { tag: "foo", page: "999" },
      db,
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain("A tagged photo");
    expect(db.bound.at(-1)).toEqual([3, 24, 0]);
  });

  it("renders every index tag, including a zero-photo tag", async () => {
    const result = await invoke(
      TagsPage,
      "/tags",
      undefined,
      mockDb({ tags: [{ id: 1, name: "empty", photo_count: 0 }, { id: 2, name: "東京", photo_count: 4 }] }),
    );
    expect(result.status).toBe(200);
    expect(result.body).toContain('href="/tags/empty"');
    expect(result.body).toContain(`/tags/${encodeURIComponent("東京")}`);
    expect(result.body).toContain("0");
  });
});
