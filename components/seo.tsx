import type { SeoData } from "../lib/seo";
import { SITE_LOCALE, SITE_NAME, SITE_TWITTER } from "../lib/site";

export function Seo({ seo }: { seo: SeoData }) {
  return (
    <>
      <title>{seo.title}</title>
      <meta name="description" content={seo.description} />
      <link rel="canonical" href={seo.canonical} />
      <meta property="og:title" content={seo.title} />
      <meta property="og:description" content={seo.description} />
      <meta property="og:image" content={seo.imageUrl} />
      <meta property="og:image:width" content={String(seo.imageWidth)} />
      <meta property="og:image:height" content={String(seo.imageHeight)} />
      <meta property="og:image:alt" content={seo.imageAlt} />
      <meta property="og:image:type" content={seo.imageType} />
      <meta property="og:type" content={seo.ogType} />
      {seo.publishedTime && <meta property="article:published_time" content={seo.publishedTime} />}
      {seo.authorUrl && <meta property="article:author" content={seo.authorUrl} />}
      <meta property="og:url" content={seo.canonical} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:locale" content={SITE_LOCALE} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:site" content={SITE_TWITTER} />
      {/* X has produced card-less previews with only og:image, so keep this duplication. */}
      <meta name="twitter:image" content={seo.imageUrl} />
      <meta name="twitter:image:alt" content={seo.imageAlt} />
      {/* og values supply title/description; creator is omitted until users have Twitter handles. */}
      {seo.jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: seo.jsonLd }} />
      )}
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
