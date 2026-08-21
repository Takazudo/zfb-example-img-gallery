import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../../components/empty-state";
import { TagList } from "../../components/tag-list";
import { getSessionUser } from "../../lib/auth";
import { listAllTagsWithCounts } from "../../lib/db/tags";
import type { Env } from "../../lib/env";
import { buildPageSeo } from "../../lib/seo";
import { SITE_NAME } from "../../lib/site";
import GalleryLayout from "../../layouts/gallery-layout";

export const prerender = false;

export default async function TagsPage() {
  const { env, request } = getCloudflareContext<Env>();
  const [tags, sessionUser] = await Promise.all([
    listAllTagsWithCounts(env),
    getSessionUser(env, request),
  ]);
  const user = sessionUser ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key } : null;

  return (
    <GalleryLayout
      title="Tags"
      activePath="/tags"
      user={user}
      seo={buildPageSeo({
        request,
        title: "Tags",
        description: `Browse photo tags on ${SITE_NAME}.`,
        path: "/tags",
      })}
    >
      <section class="flex flex-col gap-vsp-sm">
        <div>
          <h1 class="text-display font-semibold tracking-tight">Tags</h1>
          <p class="mt-vsp-2xs text-body text-ink-soft">Browse every tag in the gallery.</p>
        </div>
        {tags.length > 0 ? (
          <TagList
            size="md"
            tags={tags.map((tag) => ({ name: tag.name, count: tag.photo_count }))}
          />
        ) : (
          <EmptyState title="No tags yet" />
        )}
      </section>
    </GalleryLayout>
  );
}
