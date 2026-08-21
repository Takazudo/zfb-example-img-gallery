import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { VNode } from "preact";
import { EmptyState } from "../../../components/empty-state";
import { Pagination } from "../../../components/pagination";
import { PhotoCard } from "../../../components/photo-card";
import { PhotoGrid } from "../../../components/photo-grid";
import { getSessionUser } from "../../../lib/auth";
import {
  countPhotosByTag,
  getTagByName,
  listPhotosByTag,
  normalizeTagName,
  resolveTagPage,
  type TagRow,
  type TaggedPhoto,
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

function TagDetailBody({ tag, photos, total, page, totalPages }: {
  tag: TagRow;
  photos: TaggedPhoto[];
  total: number;
  page: number;
  totalPages: number;
}) {
  const encoded = encodeURIComponent(tag.name);
  const hrefFor = (pageNumber: number) => (
    pageNumber === 1 ? `/tags/${encoded}` : `/tags/${encoded}/page/${pageNumber}`
  );

  return (
    <>
      <section class="mb-vsp-lg">
        <h1 class="text-display font-semibold tracking-tight">#{tag.name}</h1>
        <p class="mt-vsp-2xs text-body text-ink-soft">
          {total} {total === 1 ? "photo" : "photos"}
        </p>
      </section>
      {photos.length > 0 ? (
        <PhotoGrid>
          {photos.map((photo, index) => (
            <PhotoCard
              key={photo.id}
              priority={index === 0}
              photo={{
                id: photo.id,
                title: photo.title,
                src: `/img/${photo.thumb_key ?? photo.r2_key}`,
                width: photo.width,
                height: photo.height,
              }}
            />
          ))}
        </PhotoGrid>
      ) : (
        <EmptyState title={`No photos tagged #${tag.name}`} />
      )}
      {totalPages > 1 ? <Pagination page={page} pageCount={totalPages} href={hrefFor} /> : null}
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

  const total = await countPhotosByTag(env, tag.id);
  const pageMeta = resolveTagPage(params?.page, total);
  const photos = await listPhotosByTag(env, tag.id, pageMeta.pageSize, pageMeta.offset);
  const encoded = encodeURIComponent(tag.name);
  const canonicalPath = pageMeta.page === 1
    ? `/tags/${encoded}`
    : `/tags/${encoded}/page/${pageMeta.page}`;

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
        photos={photos}
        total={total}
        page={pageMeta.page}
        totalPages={pageMeta.totalPages}
      />
    </GalleryLayout>
  );
}

export default async function TagDetailPage({ params }: TagRouteProps = {}) {
  return renderTagDetailRoute(params);
}
