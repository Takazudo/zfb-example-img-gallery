import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { Env } from "../../lib/env";
import { getObject, headObject, isServableKey } from "../../lib/storage";

export const prerender = false;

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

function hitHeaders(object: R2Object): Headers {
  return new Headers({
    "cache-control": IMMUTABLE_CACHE,
    "content-length": String(object.size),
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  });
}

function stripWeakTag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const expected = stripWeakTag(etag);
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || stripWeakTag(value) === expected;
  });
}

export default async function ImgRoute({
  params,
}: {
  params?: { key?: string | string[] };
}): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const raw = params?.key;
  const key = Array.isArray(raw) ? raw.join("/") : (raw ?? "");

  if (!isServableKey(key)) {
    return new Response("Bad request", {
      status: 400,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }

  const object = request.method === "HEAD" ? await headObject(env, key) : await getObject(env, key);
  if (!object) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const headers = hitHeaders(object);
  if (etagMatches(request.headers.get("if-none-match"), object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, { headers });
}
