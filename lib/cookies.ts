/**
 * Cookie helpers. The Worker runtime hands us the raw `Cookie:` request header
 * and expects a raw `Set-Cookie:` response header — there is no cookie object,
 * so parse and serialise by hand.
 */

const SESSION_COOKIE = "sid";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

export function readSessionId(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE);
}

/** HttpOnly (no JS access), Secure (Workers is always HTTPS), SameSite=Lax
 *  (the CSRF mitigation — see the note in lib/auth.ts), 7 days, mirrored by
 *  sessions.expires_at.
 */
export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
