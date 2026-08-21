import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../../../components/empty-state";
import { Pagination } from "../../../components/pagination";
import { PhotoCard } from "../../../components/photo-card";
import { PhotoGrid } from "../../../components/photo-grid";
import { authorHref, AUTHOR_PAGE_SIZE, countPhotosByAuthor, getAuthorByUsername, listPhotosByAuthor, resolvePageWindow } from "../../../lib/db/authors";
import type { AuthorProfile } from "../../../lib/db/authors";
import type { Env } from "../../../lib/env";
import { htmlResponse } from "../../../lib/render";
import { buildPageSeo } from "../../../lib/seo";
import GalleryLayout from "../../../layouts/gallery-layout";

// Reads D1 for every request — never prerendered.
export const prerender = false;

function photoCountLabel(count: number): string {
  return `${count} photo${count === 1 ? "" : "s"}`;
}

function authorAvatar(author: AuthorProfile) {
  return author.avatar_key ? (
    <img
      src={`/img/${author.avatar_key}`}
      alt=""
      width={96}
      height={96}
      class="size-24 rounded-full object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      class="inline-flex size-24 items-center justify-center rounded-pill bg-brand-soft text-display font-semibold text-brand"
      style={{ width: "6rem", height: "6rem" }}
    >
      {author.username.charAt(0).toUpperCase()}
    </span>
  );
}

function notFoundResponse(): Response {
  return htmlResponse(
    <GalleryLayout title="Author not found" activePath="/authors">
      <section class="flex flex-col gap-vsp-sm">
        <h1 class="text-display font-semibold tracking-tight">Author not found</h1>
        <p class="text-body text-ink-soft">
          That author does not exist. <a class="underline hover:text-brand" href="/authors">Browse all authors</a>.
        </p>
      </section>
    </GalleryLayout>,
    404,
  );
}

export async function renderAuthorDetail(username: string, rawPage?: string): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const author = await getAuthorByUsername(env, username);
  if (author === null) return notFoundResponse();

  // Count first: totalPages is required before the stable page window can be read.
  const total = await countPhotosByAuthor(env, author.id);
  const window = resolvePageWindow(rawPage, total, AUTHOR_PAGE_SIZE);
  const photos = await listPhotosByAuthor(env, author.id, AUTHOR_PAGE_SIZE, window.offset);
  const href = authorHref(author.username, window.page);

  return htmlResponse(
    <GalleryLayout
      title={`@${author.username}`}
      activePath="/authors"
      seo={buildPageSeo({
        request,
        title: `@${author.username}`,
        description: `@${author.username} has ${photoCountLabel(total)} in Stillframe.`,
        path: href,
      })}
    >
      <section class="mb-vsp-lg flex flex-col gap-vsp-md sm:flex-row sm:items-center">
        {authorAvatar(author)}
        <div>
          <h1 class="text-display font-semibold tracking-tight">@{author.username}</h1>
          <p class="mt-vsp-2xs text-body text-ink-soft">{photoCountLabel(total)}</p>
        </div>
      </section>

      {total === 0 ? (
        <EmptyState title="No photos yet">
          This author has not shared a photograph.
        </EmptyState>
      ) : (
        <>
          <PhotoGrid>
            {photos.map((photo, index) => (
              <PhotoCard
                key={photo.id}
                priority={window.page === 1 && index === 0}
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
          {window.totalPages > 1 ? (
            <Pagination
              page={window.page}
              pageCount={window.totalPages}
              href={(page) => authorHref(author.username, page)}
            />
          ) : null}
        </>
      )}
    </GalleryLayout>,
  );
}

export default function AuthorDetailPage({ params }: { params: { username: string } }): Promise<Response> {
  return renderAuthorDetail(params.username);
}
