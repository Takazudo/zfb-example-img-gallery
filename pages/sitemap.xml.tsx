import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { Env } from "../lib/env";
import { sitemapBody } from "../lib/seo";
import { siteOrigin } from "../lib/site";

export const prerender = false;
export const contentType = "application/xml; charset=utf-8";

type SitemapPhoto = { id: string | number; created_at: string | number };
type SitemapAuthor = { username: string };
type SitemapTag = { name: string };

export default async function SitemapRoute(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const [photos, authors, tags] = await Promise.all([
    env.DB.prepare(
      "SELECT id, created_at FROM photos ORDER BY created_at DESC, id DESC LIMIT 5000",
    ).all<SitemapPhoto>(),
    env.DB.prepare(
      `SELECT DISTINCT u.username FROM users u
         JOIN photos p ON p.user_id = u.id
         ORDER BY u.username`,
    ).all<SitemapAuthor>(),
    env.DB.prepare(
      `SELECT DISTINCT t.name FROM tags t
         JOIN photo_tags pt ON pt.tag_id = t.id
         ORDER BY t.name`,
    ).all<SitemapTag>(),
  ]);

  return new Response(sitemapBody({
    origin: siteOrigin(request),
    photos: photos.results,
    authors: authors.results.map(({ username }) => username),
    tags: tags.results.map(({ name }) => name),
  }), { headers: { "content-type": contentType } });
}
