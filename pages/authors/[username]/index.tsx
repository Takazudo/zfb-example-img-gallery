import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../../../components/empty-state";
import { authorFeedScope, PhotoFeed } from "../../../components/photo-feed";
import { authorHref, getAuthorByUsername, listAuthorPhotoPage } from "../../../lib/db/authors";
import type { AuthorProfile } from "../../../lib/db/authors";
import { getSessionUser } from "../../../lib/auth";
import type { Env } from "../../../lib/env";
import { htmlResponse } from "../../../lib/render";
import { buildPageSeo } from "../../../lib/seo";
import GalleryLayout, { type LayoutUser } from "../../../layouts/gallery-layout";

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

function notFoundResponse(user: LayoutUser | null): Response {
  return htmlResponse(
    <GalleryLayout title="Author not found" activePath="/authors" user={user}>
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
  const [author, sessionUser] = await Promise.all([
    getAuthorByUsername(env, username),
    getSessionUser(env, request),
  ]);
  const user = sessionUser
    ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key }
    : null;
  if (author === null) return notFoundResponse(user);

  const result = await listAuthorPhotoPage(env, author.id, rawPage);
  const href = authorHref(author.username, result.page);

  return htmlResponse(
    <GalleryLayout
      title={`@${author.username}`}
      activePath="/authors"
      user={user}
      seo={buildPageSeo({
        request,
        title: `@${author.username}`,
        description: `@${author.username} has ${photoCountLabel(result.totalItems)} in Stillframe.`,
        path: href,
      })}
    >
      <section class="mb-vsp-lg flex flex-col gap-vsp-md sm:flex-row sm:items-center">
        {authorAvatar(author)}
        <div>
          <h1 class="text-display font-semibold tracking-tight">@{author.username}</h1>
          <p class="mt-vsp-2xs text-body text-ink-soft">{photoCountLabel(result.totalItems)}</p>
        </div>
      </section>

      <PhotoFeed
        scope={authorFeedScope(author.id)}
        page={result}
        nextHref={authorHref(author.username, result.page + 1)}
        photos={result.items}
        empty={result.totalItems === 0 ? (
          <EmptyState title="No photos yet">
            This author has not shared a photograph.
          </EmptyState>
        ) : null}
      />
    </GalleryLayout>,
  );
}

export default function AuthorDetailPage({ params }: { params: { username: string } }): Promise<Response> {
  return renderAuthorDetail(params.username);
}
