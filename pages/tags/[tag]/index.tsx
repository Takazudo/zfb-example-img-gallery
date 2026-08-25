import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { VNode } from "preact";
import { EmptyState } from "../../../components/empty-state";
import { PhotoFeed, tagFeedScope } from "../../../components/photo-feed";
import { getSessionUser } from "../../../lib/auth";
import {
  getTagByName,
  listTagPhotoPage,
  normalizeTagName,
  parseTagPage,
  type TagRow,
} from "../../../lib/db/tags";
import type { Env } from "../../../lib/env";
import { htmlResponse } from "../../../lib/render";
import { buildPageSeo } from "../../../lib/seo";
import { SITE_NAME } from "../../../lib/site";
import GalleryLayout, { type LayoutUser } from "../../../layouts/gallery-layout";

export const prerender = false;

export type TagRouteParams = { tag?: string; page?: string };
export type TagRouteProps = { params?: TagRouteParams };
export type TagRouteResult = VNode | Response;

function layoutUser(sessionUser: Awaited<ReturnType<typeof getSessionUser>>): LayoutUser | null {
  return sessionUser ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key } : null;
}

function notFound(user: LayoutUser | null): Response {
  return htmlResponse(
    <GalleryLayout title="Tag not found" activePath="/tags" user={user}>
      <EmptyState title="Tag not found">The requested tag does not exist.</EmptyState>
    </GalleryLayout>,
    404,
  );
}

function TagDetailBody({ tag, page, nextHref }: {
  tag: TagRow;
  page: Awaited<ReturnType<typeof listTagPhotoPage>>;
  nextHref: string;
}) {
  return (
    <>
      <section class="mb-vsp-lg">
        <h1 class="text-display font-semibold tracking-tight">#{tag.name}</h1>
        <p class="mt-vsp-2xs text-body text-ink-soft">
          {page.totalItems} {page.totalItems === 1 ? "photo" : "photos"}
        </p>
      </section>
      <PhotoFeed
        scope={tagFeedScope(tag.id)}
        page={page}
        nextHref={nextHref}
        photos={page.items}
        empty={<EmptyState title={`No photos tagged #${tag.name}`} />}
      />
    </>
  );
}

export async function renderTagDetailRoute(params?: TagRouteParams): Promise<TagRouteResult> {
  const { env, request } = getCloudflareContext<Env>();
  const sessionUser = await getSessionUser(env, request);
  const user = layoutUser(sessionUser);
  const name = normalizeTagName(params?.tag ?? "");
  if (!name) return notFound(user);

  const tag = await getTagByName(env, name);
  if (!tag) return notFound(user);

  // Keep the tag route's established strict page-param contract while using
  // the shared page result shape for the feed metadata.
  const pageMeta = await listTagPhotoPage(env, tag.id, parseTagPage(params?.page), sessionUser?.id);
  const encoded = encodeURIComponent(tag.name);
  const canonicalPath = pageMeta.page === 1
    ? `/tags/${encoded}`
    : `/tags/${encoded}/page/${pageMeta.page}`;
  const nextHref = `/tags/${encoded}/page/${pageMeta.page + 1}`;

  return (
    <GalleryLayout
      title={`#${tag.name}`}
      activePath="/tags"
      user={user}
      seo={buildPageSeo({
        request,
        title: `#${tag.name}`,
        description: `Photos tagged #${tag.name} on ${SITE_NAME}.`,
        path: canonicalPath,
      })}
    >
      <TagDetailBody
        tag={tag}
        page={pageMeta}
        nextHref={nextHref}
      />
    </GalleryLayout>
  );
}

export default async function TagDetailPage({ params }: TagRouteProps = {}) {
  return renderTagDetailRoute(params);
}
