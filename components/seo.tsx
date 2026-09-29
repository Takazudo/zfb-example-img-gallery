import type { SeoData } from "../lib/seo";
import { SITE_LOCALE, SITE_NAME, SITE_TWITTER } from "../lib/site";
import { unlisted } from "../lib/unlisted-attributes";

/** Head-only: GalleryLayout pre-renders the head with renderWithUnlistedAttributes(). */
export function Seo({ seo }: { seo: SeoData }) {
  return (
    <>
      <title>{seo.title}</title>
      <meta name="description" content={seo.description} />
      <link rel="canonical" href={seo.canonical} />
      <meta {...unlisted("property", "og:title")} content={seo.title} />
      <meta {...unlisted("property", "og:description")} content={seo.description} />
      <meta {...unlisted("property", "og:image")} content={seo.imageUrl} />
      <meta {...unlisted("property", "og:image:width")} content={String(seo.imageWidth)} />
      <meta {...unlisted("property", "og:image:height")} content={String(seo.imageHeight)} />
      <meta {...unlisted("property", "og:image:alt")} content={seo.imageAlt} />
      <meta {...unlisted("property", "og:image:type")} content={seo.imageType} />
      <meta {...unlisted("property", "og:type")} content={seo.ogType} />
      {seo.publishedTime && <meta {...unlisted("property", "article:published_time")} content={seo.publishedTime} />}
      {seo.authorUrl && <meta {...unlisted("property", "article:author")} content={seo.authorUrl} />}
      <meta {...unlisted("property", "og:url")} content={seo.canonical} />
      <meta {...unlisted("property", "og:site_name")} content={SITE_NAME} />
      <meta {...unlisted("property", "og:locale")} content={SITE_LOCALE} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content={SITE_TWITTER} />
      {/* X has produced card-less previews with only og:image, so keep this duplication. */}
      <meta name="twitter:image" content={seo.imageUrl} />
      <meta name="twitter:image:alt" content={seo.imageAlt} />
      {/* og values supply title/description; creator is omitted until users have Twitter handles. */}
      {/* Not a trusted constant: jsonLd carries photo metadata and must come from
          jsonLdBody(), which escapes every "<" so the payload cannot close the script. */}
      {seo.jsonLd && <script type="application/ld+json" rawHtml={seo.jsonLd} />}
    </>
  );
}

export function FaviconLinks() {
  return (
    <>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/site.webmanifest" />
    </>
  );
}
