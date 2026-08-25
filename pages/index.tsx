import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../components/empty-state";
import { GLOBAL_FEED_SCOPE, PhotoFeed } from "../components/photo-feed";
import GalleryLayout from "../layouts/gallery-layout";
import { getSessionUser } from "../lib/auth";
import { listPhotoPage } from "../lib/db/photos";
import type { Env } from "../lib/env";
import { buildPageSeo } from "../lib/seo";
import { SITE_NAME } from "../lib/site";

export const prerender = false;

export default async function TopPage() {
  const { env, request } = getCloudflareContext<Env>();
  const sessionUser = await getSessionUser(env, request);
  const result = await listPhotoPage(env, 1, sessionUser?.id);
  const user = sessionUser
    ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key }
    : null;
  const seo = buildPageSeo({ request, title: SITE_NAME, path: "/" });

  return (
    <GalleryLayout user={user} activePath="/" seo={seo}>
      <section class="flex flex-col gap-vsp-md">
        <h1 class="text-display font-semibold tracking-tight">{SITE_NAME}</h1>
        <PhotoFeed
          scope={GLOBAL_FEED_SCOPE}
          page={result}
          nextHref="/page/2"
          photos={result.items}
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
