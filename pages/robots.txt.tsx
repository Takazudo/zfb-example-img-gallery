import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { Env } from "../lib/env";
import { robotsBody } from "../lib/seo";
import { siteOrigin } from "../lib/site";

export const prerender = false;
export const contentType = "text/plain; charset=utf-8";

export default async function RobotsRoute(): Promise<Response> {
  const { request } = getCloudflareContext<Env>();
  return new Response(robotsBody(siteOrigin(request)), {
    headers: { "content-type": contentType },
  });
}
