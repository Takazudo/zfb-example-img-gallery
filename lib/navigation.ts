/**
 * Helpers for redirects that are chosen from request input.
 *
 * A path is deliberately validated as a URL-relative path instead of merely
 * checking that it starts with `/`: `//host.example` is a protocol-relative
 * external URL and a backslash can be normalised into one by URL parsing.
 */

export const MAX_SAFE_RELATIVE_PATH_LENGTH = 2048;

function hasUnsafeCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\\]/.test(value);
}

/** Return true only for an internal, absolute-path relative URL. */
export function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_SAFE_RELATIVE_PATH_LENGTH
    || !value.startsWith("/")
    || value.startsWith("//")
    || hasUnsafeCharacters(value)
  ) return false;

  try {
    const parsed = new URL(value, "https://safe-relative.invalid");
    return parsed.origin === "https://safe-relative.invalid" && parsed.pathname.startsWith("/");
  } catch {
    return false;
  }
}

/** Fall back to a known internal path when request input is not safe. */
export function safeRelativePath(value: unknown, fallback = "/"): string {
  return isSafeRelativePath(value)
    ? value
    : (isSafeRelativePath(fallback) ? fallback : "/");
}

/** The path/query portion of the current request, suitable for login `next`. */
export function requestRelativePath(request: Request, fallback = "/"): string {
  try {
    const url = new URL(request.url);
    return safeRelativePath(`${url.pathname}${url.search}`, fallback);
  } catch {
    return fallback;
  }
}

/** Build the login URL while retaining only a validated internal destination. */
export function loginPath(next = "/"): string {
  const destination = safeRelativePath(next, "/");
  return destination === "/" ? "/login" : `/login?next=${encodeURIComponent(destination)}`;
}

/**
 * JSON is an enhancement contract only when the request is same-origin. The
 * absence of Origin/Referer is normal for same-origin browser fetches and for
 * the small Request fixtures used by the handler tests, so it is accepted.
 */
export function isSameOriginRequest(request: Request): boolean {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== target.origin) return false;

  const referer = request.headers.get("referer");
  if (referer !== null) {
    try {
      if (new URL(referer).origin !== target.origin) return false;
    } catch {
      return false;
    }
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") return false;
  return true;
}

/** Whether the response should use the enhanced JSON mutation contract. */
export function wantsJsonResponse(request: Request): boolean {
  if (!isSameOriginRequest(request)) return false;
  const accept = request.headers.get("accept") ?? "";
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  return /(?:^|,)\s*application\/json(?:\s*;|\s*,|\s*$)/i.test(accept)
    || request.headers.get("x-requested-with")?.toLowerCase() === "xmlhttprequest"
    || contentType === "application/json";
}
