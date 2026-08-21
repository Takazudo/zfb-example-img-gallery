import { ogImagePath } from "./og";
import { SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "./site";

const MAX_DESCRIPTION = 160;

export type SeoData = {
  title: string;
  description: string;
  canonical: string;
  ogType: "website" | "article";
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  imageAlt: string;
  imageType: string;
  publishedTime?: string;
  authorUrl?: string;
  jsonLd?: string;
};

export function absoluteUrl(pathname: string, origin: string): string {
  const url = new URL(pathname, origin);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function canonicalFor(request: Request, origin: string, overridePath?: string): string {
  return absoluteUrl(overridePath ?? new URL(request.url).pathname, origin);
}

export function pageTitle(title?: string | null): string {
  const normalized = (title ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return SITE_NAME;
  if (normalized === SITE_NAME || normalized.endsWith(`| ${SITE_NAME}`)) return normalized;
  return `${normalized} | ${SITE_NAME}`;
}

export function metaDescription(raw: string | null | undefined, fallback: string): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  const source = collapsed.length > 0 ? collapsed : fallback;
  if (source.length <= MAX_DESCRIPTION) return source;
  const cut = source.slice(0, MAX_DESCRIPTION - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function toIso8601(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;

  let milliseconds: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  } else {
    const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
    milliseconds = Date.parse(sqlite ? `${value.replace(" ", "T")}Z` : value);
  }

  if (!Number.isFinite(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

export function jsonLdBody(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildPageSeo(input: {
  request: Request;
  title?: string;
  description?: string;
  path?: string;
}): SeoData {
  const origin = siteOrigin(input.request);
  return {
    title: pageTitle(input.title),
    description: metaDescription(input.description, SITE_DESCRIPTION),
    canonical: canonicalFor(input.request, origin, input.path),
    ogType: "website",
    imageUrl: absoluteUrl("/og-fallback.jpg", origin),
    imageWidth: 1200,
    imageHeight: 630,
    imageAlt: SITE_NAME,
    imageType: "image/jpeg",
  };
}

export function buildPhotoSeo(input: {
  request: Request;
  photo: {
    id: string | number;
    title: string;
    description: string | null;
    r2_key: string;
    thumb_key: string | null;
    width: number;
    height: number;
    content_type: string;
    created_at: string | number;
  };
  authorUsername: string;
  tags: string[];
}): SeoData {
  const { request, photo, authorUsername, tags } = input;
  const origin = siteOrigin(request);
  const description = metaDescription(
    photo.description,
    `A photo titled "${photo.title}" on ${SITE_NAME}.`,
  );
  const publishedTime = toIso8601(photo.created_at);
  const authorUrl = absoluteUrl(`/authors/${encodeURIComponent(authorUsername)}`, origin);
  const contentUrl = absoluteUrl(`/img/${photo.r2_key}`, origin);
  const thumbnailUrl = photo.thumb_key
    ? absoluteUrl(`/img/${photo.thumb_key}`, origin)
    : undefined;

  const imageObject = {
    "@context": "https://schema.org",
    "@type": "ImageObject",
    name: photo.title,
    description,
    contentUrl,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    width: photo.width,
    height: photo.height,
    ...(publishedTime ? { uploadDate: publishedTime } : {}),
    author: { "@type": "Person", name: `@${authorUsername}`, url: authorUrl },
    ...(tags.length > 0 ? { keywords: tags.join(", ") } : {}),
  };

  return {
    title: pageTitle(photo.title),
    description,
    canonical: canonicalFor(request, origin, `/photos/${photo.id}`),
    ogType: "article",
    imageUrl: absoluteUrl(ogImagePath(String(photo.id)), origin),
    imageWidth: 1200,
    imageHeight: 630,
    imageAlt: photo.title,
    imageType: "image/jpeg",
    ...(publishedTime ? { publishedTime } : {}),
    authorUrl,
    jsonLd: jsonLdBody(imageObject),
  };
}

export function robotsBody(origin: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /login",
    "Disallow: /logout",
    "Disallow: /register",
    "Disallow: /settings",
    "Disallow: /upload",
    "",
    `Sitemap: ${absoluteUrl("/sitemap.xml", origin)}`,
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sitemapBody(input: {
  origin: string;
  photos: Array<{ id: string | number; created_at: string | number }>;
  authors: string[];
  tags: string[];
}): string {
  const urls: Array<{ loc: string; lastmod?: string }> = [
    { loc: absoluteUrl("/", input.origin) },
    { loc: absoluteUrl("/authors", input.origin) },
    { loc: absoluteUrl("/tags", input.origin) },
    ...input.photos.map((photo) => ({
      loc: absoluteUrl(`/photos/${photo.id}`, input.origin),
      lastmod: toIso8601(photo.created_at)?.slice(0, 10),
    })),
    ...input.authors.map((username) => ({
      loc: absoluteUrl(`/authors/${encodeURIComponent(username)}`, input.origin),
    })),
    ...input.tags.map((tag) => ({
      loc: absoluteUrl(`/tags/${encodeURIComponent(tag)}`, input.origin),
    })),
  ];

  const entries = urls.map(({ loc, lastmod }) => {
    const modified = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : "";
    return `<url><loc>${escapeXml(loc)}</loc>${modified}</url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join("")}</urlset>\n`;
}
