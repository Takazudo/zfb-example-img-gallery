import type { ComponentChildren } from "preact";
import { PhotoCard, type PhotoCardPhoto } from "./photo-card";
import { PhotoGrid } from "./photo-grid";
import { PHOTO_PAGE_SIZE } from "../lib/db/photos";
import type { PageMeta, PhotoCard as PhotoRow } from "../lib/types";

/** Stable collection identity used by the global server-rendered feed. */
export const GLOBAL_FEED_SCOPE = "global";

/** Stable collection identity used by an author feed. */
export function authorFeedScope(authorId: number): string {
  return `author:${authorId}`;
}

/** Stable collection identity used by a tag feed. */
export function tagFeedScope(tagId: number): string {
  return `tag:${tagId}`;
}

/** The next batch can never be larger than the established 24-item page size. */
export function remainingPhotoCount(page: Pick<PageMeta, "page" | "pageSize" | "totalItems">): number {
  return Math.max(0, Math.min(PHOTO_PAGE_SIZE, page.pageSize, page.totalItems - page.page * page.pageSize));
}

function toPhotoCardPhoto(photo: PhotoRow): PhotoCardPhoto {
  return {
    id: photo.id,
    title: photo.title,
    src: `/img/${photo.thumb_key ?? photo.r2_key}`,
    width: photo.width,
    height: photo.height,
    blurhash: photo.blurhash,
  };
}

type Props = {
  /** Deterministic scope key consumed by the later loading/history controller. */
  scope: string;
  /** Shared page metadata returned by the collection query. */
  page: PageMeta;
  /** Canonical URL for the immediately following server-rendered page. */
  nextHref: string;
  photos: PhotoRow[];
  /** Empty-state content remains server-authored inside the marked feed. */
  empty?: ComponentChildren;
};

/**
 * Shared SSR feed contract for every photo collection.
 *
 * This deliberately renders a normal section/grid/link instead of an Island:
 * the client enhancement can discover and replace the marked metadata later,
 * while direct page URLs remain useful with JavaScript disabled.
 */
export function PhotoFeed({ scope, page, nextHref, photos, empty }: Props) {
  const nextCount = remainingPhotoCount(page);
  const hasNext = page.hasNext && nextCount > 0;
  const terminal = !hasNext;

  // Preact serializes the terminal empty value as a valueless data attribute;
  // the browser exposes that as an empty dataset value.
  // Narrow compatibility hook for the client enhancement: this server-owned,
  // stable live region lets loading/retry/end announcements survive link updates.
  return (
    <section
      data-gallery-feed="true"
      data-gallery-scope={scope}
      data-gallery-page={String(page.page)}
      data-gallery-total-pages={String(page.totalPages)}
      data-gallery-total-items={String(page.totalItems)}
      data-gallery-page-size={String(page.pageSize)}
      data-gallery-next-url={hasNext ? nextHref : ""}
      data-gallery-next-count={String(nextCount)}
      data-gallery-terminal={String(terminal)}
    >
      {photos.length > 0 ? (
        <PhotoGrid>
          {photos.map((photo, index) => (
            <PhotoCard
              key={photo.id}
              photo={toPhotoCardPhoto(photo)}
              priority={page.page === 1 && index === 0}
            />
          ))}
        </PhotoGrid>
      ) : empty ?? null}
      {hasNext ? (
        <nav data-gallery-feed-next class="mt-vsp-md flex justify-center" aria-label="More photos">
          <a
            data-gallery-next-link="true"
            data-gallery-next-url={nextHref}
            data-gallery-next-count={String(nextCount)}
            href={nextHref}
            class="inline-flex min-h-[2.75rem] items-center rounded-md px-hsp-md text-small text-brand underline hover:text-brand-strong"
          >
            {`Load next ${nextCount} photos`}
          </a>
        </nav>
      ) : null}
      <p
        data-gallery-status="true"
        aria-live="polite"
        aria-atomic="true"
        hidden
        class="mt-vsp-xs text-center text-small text-ink-soft"
      />
    </section>
  );
}
