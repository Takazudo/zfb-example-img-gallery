import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { getSessionUser } from "../../lib/auth";
import { getPhotoDetail } from "../../lib/db/photos";
import type { Env } from "../../lib/env";
import { ogImagePath } from "../../lib/og";
import { htmlResponse } from "../../lib/render";
import {
  absoluteUrl,
  jsonLdBody,
  metaDescription,
  pageTitle,
  type SeoData,
} from "../../lib/seo";
import { siteOrigin } from "../../lib/site";
import GalleryLayout, { type LayoutUser } from "../../layouts/gallery-layout";
import { PlaceholderImage } from "../../components/placeholder-image";

export const prerender = false;

type Props = { params: { id: string } };

/** D1 stores UTC without a zone marker; append "Z" so Date parses it as UTC. */
function toIso(sqliteTimestamp: string): string {
  const timestamp = sqliteTimestamp.includes("T")
    ? sqliteTimestamp
    : sqliteTimestamp.replace(" ", "T");
  return new Date(timestamp.endsWith("Z") ? timestamp : `${timestamp}Z`).toISOString();
}

function layoutUser(user: Awaited<ReturnType<typeof getSessionUser>>): LayoutUser | null {
  return user ? { username: user.username, avatarKey: user.avatar_key } : null;
}

function notFound(request: Request, user: LayoutUser | null): Response {
  return htmlResponse(
    <GalleryLayout user={user} seo={{
      title: pageTitle("Photo not found"),
      description: "The requested photo could not be found.",
      canonical: absoluteUrl(new URL(request.url).pathname, siteOrigin(request)),
      ogType: "website",
      imageUrl: absoluteUrl("/og-fallback.jpg", siteOrigin(request)),
      imageWidth: 1200,
      imageHeight: 630,
      imageAlt: "Photo not found",
      imageType: "image/jpeg",
    }}>
      <section class="mx-auto w-full max-w-[40rem] text-center">
        <h1 class="text-title font-bold text-ink">Photo not found</h1>
        <p class="mt-vsp-xs text-body text-ink-soft">
          The requested photo does not exist or its address is invalid.
        </p>
      </section>
    </GalleryLayout>,
    404,
  );
}

export default async function PhotoDetailPage({ params }: Props): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const raw = params?.id ?? "";
  if (!/^[1-9]\d{0,14}$/.test(raw)) return notFound(request, null);

  const id = Number(raw);
  const sessionUser = await getSessionUser(env, request);
  const user = layoutUser(sessionUser);
  const detail = await getPhotoDetail(env, id, sessionUser?.id);
  if (!detail) return notFound(request, user);

  const { photo, author } = detail;
  const tags = detail.tags.map((tag) => tag.name);
  const descriptionText =
    photo.description.trim() || `${photo.title} — posted by @${author.username}.`;
  const description = metaDescription(
    photo.description,
    `${photo.title} — a photo posted by @${author.username}.`,
  );
  const publishedIso = toIso(photo.created_at);
  const publishedLabel = new Date(publishedIso).toUTCString();
  const origin = siteOrigin(request);
  const authorUrl = absoluteUrl(
    `/authors/${encodeURIComponent(author.username)}`,
    origin,
  );
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ImageObject",
    name: photo.title,
    description: photo.description.replace(/\s+/g, " ").trim() || descriptionText,
    contentUrl: absoluteUrl(`/img/${photo.r2_key}`, origin),
    ...(photo.thumb_key
      ? { thumbnailUrl: absoluteUrl(`/img/${photo.thumb_key}`, origin) }
      : {}),
    width: photo.width,
    height: photo.height,
    uploadDate: publishedIso,
    author: {
      "@type": "Person",
      name: `@${author.username}`,
      url: authorUrl,
    },
    ...(tags.length > 0 ? { keywords: tags.join(", ") } : {}),
  };
  const seo: SeoData = {
    title: pageTitle(photo.title),
    description,
    canonical: absoluteUrl(`/photos/${id}`, origin),
    ogType: "article",
    imageUrl: absoluteUrl(ogImagePath(String(id)), origin),
    imageWidth: 1200,
    imageHeight: 630,
    imageAlt: photo.title,
    imageType: "image/jpeg",
    publishedTime: publishedIso,
    authorUrl,
    jsonLd: jsonLdBody(jsonLd),
  };

  return htmlResponse(
    <GalleryLayout user={user} seo={seo}>
      <article
        data-testid="photo-detail"
        class="mx-auto grid w-full max-w-[64rem] grid-cols-1 gap-vsp-lg md:grid-cols-[1fr_20rem] md:items-start md:gap-hsp-lg"
      >
        {/* min-w-0 lets this fluid grid track shrink below the image's intrinsic width. */}
        <div data-testid="photo-detail-media" class="min-w-0">
          <PlaceholderImage
            src={`/img/${photo.r2_key}`}
            alt={photo.title}
            width={photo.width}
            height={photo.height}
            blurhash={photo.blurhash}
            fit="contain"
            wrapperClass="w-full bg-surface-sunken"
            decoding="async"
            fetchpriority="high"
            class="mx-auto block h-auto max-h-[80vh] w-full bg-surface-sunken object-contain"
          />
        </div>

        <div
          data-testid="photo-detail-aside"
          class="flex min-w-0 flex-col gap-vsp-md"
        >
          <h1 class="text-title font-bold text-ink">{photo.title}</h1>

          <p class="text-small text-ink-soft">
            by{" "}
            <a
              href={`/authors/${encodeURIComponent(author.username)}`}
              class="font-semibold text-brand underline"
            >
              @{author.username}
            </a>
          </p>

          <p class="whitespace-pre-wrap break-words text-body text-ink">
            {descriptionText}
          </p>

          {tags.length > 0 && (
            <ul data-testid="photo-detail-tags" class="flex flex-wrap gap-hsp-xs">
              {tags.map((tag) => (
                <li key={tag}>
                  <a
                    href={`/tags/${encodeURIComponent(tag)}`}
                    class="inline-block bg-surface-sunken px-hsp-sm py-vsp-2xs text-small text-ink-soft transition-colors hover:text-brand"
                  >
                    #{tag}
                  </a>
                </li>
              ))}
            </ul>
          )}

          <p class="text-micro text-ink-soft">
            <time dateTime={publishedIso}>{publishedLabel}</time>
          </p>
        </div>
      </article>
    </GalleryLayout>,
  );
}
