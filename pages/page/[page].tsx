import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../../components/empty-state";
import { GLOBAL_FEED_SCOPE, PhotoFeed } from "../../components/photo-feed";
import GalleryLayout from "../../layouts/gallery-layout";
import { getSessionUser } from "../../lib/auth";
import { listPhotoPage } from "../../lib/db/photos";
import type { Env } from "../../lib/env";
import { buildPageSeo } from "../../lib/seo";
import { SITE_NAME } from "../../lib/site";

export const prerender = false;

/**
 * Parse a `/page/<segment>` URL segment into a requested 1-based page number.
 *
 * Malformed input degrades to page 1; a well-formed but absurdly large number
 * degrades to the last page via MAX_SAFE_INTEGER so the query module's clamp
 * handles it, rather than silently bouncing the visitor back to page 1.
 */
export function parsePageParam(raw: string | undefined): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 1;
  const n = Number(raw);
  if (n < 1) return 1;
  if (!Number.isSafeInteger(n)) return Number.MAX_SAFE_INTEGER;
  return n;
}

type PageProps = { params?: Record<string, string | undefined> };

function lastPathSegment(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  return parts.at(-1);
}

export default async function PhotoGridPage({ params }: PageProps = {}) {
  const { env, request } = getCloudflareContext<Env>();
  const rawPage = params?.page ?? lastPathSegment(new URL(request.url).pathname);
  const sessionUser = await getSessionUser(env, request);
  const result = await listPhotoPage(env, parsePageParam(rawPage), sessionUser?.id);
  const user = sessionUser
    ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key }
    : null;
  const effectivePage = result.page;
  const canonicalPath = effectivePage === 1 ? "/" : `/page/${effectivePage}`;
  const seo = buildPageSeo({
    request,
    title: effectivePage === 1 ? SITE_NAME : `Page ${effectivePage}`,
    path: canonicalPath,
  });

  return (
    <GalleryLayout user={user} activePath="/" seo={seo}>
      <section class="flex flex-col gap-vsp-md">
        <h1 class="text-display font-semibold tracking-tight">
          {effectivePage === 1 ? SITE_NAME : `${SITE_NAME} — Page ${effectivePage}`}
        </h1>
        <PhotoFeed
          scope={GLOBAL_FEED_SCOPE}
          page={result}
          nextHref={`/page/${effectivePage + 1}`}
          photos={result.items}
          viewerId={sessionUser?.id}
          returnTo={new URL(request.url).pathname}
          empty={result.totalItems === 0 ? (
            <EmptyState
              title="No photos yet"
              action={user ? { href: "/upload", label: "Upload a photo" } : { href: "/register", label: "Create an account" }}
            >
              {user ? "Share the first photo in the gallery." : "Create an account to share the first photo in the gallery."}
            </EmptyState>
          ) : null}
        />
      </section>
    </GalleryLayout>
  );
}
