import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { destroySession } from "../lib/auth";
import { clearedSessionCookie, readSessionId } from "../lib/cookies";
import type { Env } from "../lib/env";
import { redirect } from "../lib/render";

export const prerender = false;

/** POST-only on purpose: SameSite=Lax still sends the session cookie on
 * top-level cross-site GET navigations, so a GET logout is CSRF-able from a
 * bare <img src>.
 */
export default async function LogoutPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const sessionId = readSessionId(request);
  if (sessionId) await destroySession(env, sessionId);
  return redirect("/", { "set-cookie": clearedSessionCookie() });
}
