/** Human-readable brand. Matches the wordmark rendered by the shared layout. */
export const SITE_NAME = "Stillframe";

/** The gallery's account, rather than a per-photo creator identity. */
export const SITE_TWITTER = "@takazudo";

/** Default description for pages carrying no text of their own. */
export const SITE_DESCRIPTION = "A thoughtfully curated image gallery built on Cloudflare.";

export const SITE_LOCALE = "en";

/** Resolve the configured site identity at request time, falling back only when unset. */
export function siteOrigin(request: Request): string {
  const configured = (globalThis as { __zfb?: { site?: string } }).__zfb?.site;
  const raw = configured && configured.length > 0 ? configured : request.url;
  return new URL(raw).origin;
}
