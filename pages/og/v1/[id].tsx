import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { Env } from "../../../lib/env";
import {
  ensureOgCard,
  OG_CONTENT_TYPE,
  OG_FALLBACK_CACHE,
  OG_IMMUTABLE_CACHE,
  ogObjectKey,
} from "../../../lib/og";

export const prerender = false;

type PhotoSource = { id: string | number; r2_key: string };

async function loadPhotoSource(env: Env, photoId: string): Promise<PhotoSource | null> {
  return env.DB.prepare("SELECT id, r2_key FROM photos WHERE id = ?1").bind(photoId).first<PhotoSource>();
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function cardResponse(
  bytes: ArrayBuffer,
  request: Request,
  etag?: string,
): Response {
  const headers = new Headers({
    "cache-control": OG_IMMUTABLE_CACHE,
    "content-type": OG_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
  if (etag) headers.set("etag", etag);
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

async function fallbackCard(env: Env, request: Request): Promise<Response> {
  const asset = await env.ASSETS.fetch(new URL("/og-fallback.jpg", request.url));
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: 200,
    headers: {
      "content-type": OG_CONTENT_TYPE,
      "cache-control": OG_FALLBACK_CACHE,
      "x-content-type-options": "nosniff",
    },
  });
}

export default async function OgCardRoute(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const last = new URL(request.url).pathname.split("/").pop() ?? "";
  if (!last.toLowerCase().endsWith(".jpg")) return notFound();
  const photoId = last.slice(0, -4);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(photoId)) return notFound();

  const photo = await loadPhotoSource(env, photoId);
  if (!photo) return notFound();

  try {
    const hit = await env.BUCKET.get(ogObjectKey(photoId));
    if (hit) return cardResponse(await hit.arrayBuffer(), request, hit.httpEtag);
    return cardResponse(await ensureOgCard(env, photoId, photo.r2_key), request);
  } catch {
    return fallbackCard(env, request);
  }
}
