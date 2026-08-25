import { render } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctx: null as unknown as { env: unknown; request: Request },
}));
const configuredGlobal = globalThis as { __zfb?: { site?: string } };

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.ctx,
}));

import TagsPage from "../../pages/tags";
import TagDetailPage from "../../pages/tags/[tag]/index";
import type { Env } from "../../lib/env";

type Statement = {
  bind: (...values: unknown[]) => Statement;
  all: <T>() => Promise<{ results: T[] }>;
  first: <T>() => Promise<T | null>;
};

function setup(options: {
  tag?: { id: number; name: string } | null;
  total?: number;
  photos?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
}) {
  configuredGlobal.__zfb = { site: "https://gallery.example" };
  const db = {
    prepare(sql: string): Statement {
      const lower = sql.toLowerCase();
      const statement: Statement = {
        bind: () => statement,
        async all<T>() {
          if (lower.includes("from photos p")) return { results: (options.photos ?? []) as T[] };
          if (lower.includes("from tags t")) return { results: (options.tags ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (lower.includes("select id, name from tags")) return (options.tag ?? null) as T | null;
          if (lower.includes("count(*) as n")) return { n: options.total ?? 0 } as T;
          return null;
        },
      };
      return statement;
    },
  };
  h.ctx = {
    env: { DB: db } as unknown as Env,
    request: new Request("https://foreign.example/tags/Foo?page=ignored"),
  };
}

beforeEach(() => {
  h.ctx = null as unknown as { env: unknown; request: Request };
  delete configuredGlobal.__zfb;
});

afterEach(() => {
  delete configuredGlobal.__zfb;
});

describe("tag page SSR markup", () => {
  it("renders the stored name after the # in the detail heading", async () => {
    setup({
      tag: { id: 1, name: "東京" },
      total: 2,
      photos: [
        {
          id: 8,
          title: "Tokyo night",
          r2_key: "photos/8.jpg",
          thumb_key: null,
          width: 1600,
          height: 900,
          created_at: "2026-08-20 00:00:00",
          username: "alice",
        },
        {
          id: 9,
          title: "Tokyo dawn",
          r2_key: "photos/9.jpg",
          thumb_key: null,
          width: 900,
          height: 1600,
          created_at: "2026-08-19 00:00:00",
          username: "alice",
        },
      ],
    });
    const result = await TagDetailPage({ params: { tag: "東京" } });
    if (result instanceof Response) throw new Error("expected a successful SSR vnode");
    const html = render(result);
    expect(html).toMatch(/<h1[^>]*>#東京<\/h1>/);
    expect(html).toContain('src="/img/photos/8.jpg"');
    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('property="og:type" content="website"');
    expect(html).toContain(`href="https://gallery.example/tags/${encodeURIComponent("東京")}"`);
    expect(html).toContain('data-gallery-scope="tag:1|viewer:anonymous"');
    expect(html).toContain('data-gallery-terminal="true"');
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).toContain("data-theme-bootstrap");
    expect(html).toContain('type="module" src="/assets/islands.js"');
  });

  it("renders one encoded index anchor per tag with its count", async () => {
    setup({
      tags: [
        { id: 1, name: "safe", photo_count: 0 },
        { id: 2, name: "東京", photo_count: 3 },
      ],
    });
    const html = render(await TagsPage());
    expect(html.match(/href="\/tags\//g)).toHaveLength(2);
    expect(html).toContain('href="/tags/safe"');
    expect(html).toContain(`/tags/${encodeURIComponent("東京")}`);
    expect(html).toContain("0");
    expect(html).toContain("3");
  });

  it("uses the empty state and omits pagination for an empty tag", async () => {
    setup({ tag: { id: 1, name: "empty" }, total: 0, photos: [] });
    const result = await TagDetailPage({ params: { tag: "empty" } });
    if (result instanceof Response) throw new Error("expected a successful SSR vnode");
    const html = render(result);
    expect(html).toContain("No photos tagged #empty");
    expect(html).not.toMatch(/aria-label="Pagination"/);
    expect(html).toContain('data-gallery-scope="tag:1|viewer:anonymous"');
    expect(html).toContain('data-gallery-terminal="true"');
  });
});
