import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import type { VNode } from "preact";
import { EmptyState } from "../../components/empty-state";
import { PhotoFeed } from "../../components/photo-feed";
import GalleryLayout, { type LayoutUser } from "../../layouts/gallery-layout";
import { getSessionUser } from "../../lib/auth";
import {
  listFavoritePage,
  setFavoriteState,
  type FavoriteDesiredState,
} from "../../lib/db/favorites";
import { parseId } from "../../lib/db/photos";
import type { Env } from "../../lib/env";
import {
  isSafeRelativePath,
  loginPath,
  requestRelativePath,
  safeRelativePath,
  wantsJsonResponse,
} from "../../lib/navigation";
import { htmlResponse, redirect } from "../../lib/render";
import { buildPageSeo } from "../../lib/seo";
import { SITE_NAME } from "../../lib/site";

// Favorite actions carry only a few scalar fields. Keep malformed or hostile
// requests out of Worker memory before attempting to parse their body.
export const MAX_FAVORITE_BODY_BYTES = 16 * 1024;

// Reads D1 for every request — never prerendered.
export const prerender = false;

export type FavoritesRouteParams = { page?: string };
export type FavoritesRouteResult = VNode | Response;

/** Per-viewer identity prevents an expanded snapshot leaking between users. */
export function favoritesFeedScope(userId: number): string {
  return `favorites:${userId}`;
}

function layoutUser(sessionUser: Awaited<ReturnType<typeof getSessionUser>>): LayoutUser | null {
  return sessionUser ? { username: sessionUser.username, avatarKey: sessionUser.avatar_key } : null;
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: "GET, POST",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      vary: "Accept, Origin, Referer, Sec-Fetch-Site",
    },
  });
}

function htmlError(
  message: string,
  status: number,
  user: LayoutUser | null,
): Response {
  return htmlResponse(
    <GalleryLayout title="Favorites" activePath="/favorites" user={user}>
      <section class="mx-auto flex w-full max-w-[40rem] flex-col gap-vsp-sm">
        <h1 class="text-title font-semibold tracking-tight">Favorites</h1>
        <p role="alert" class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger">
          {message}
        </p>
        <p><a class="text-brand underline" href="/favorites">Back to Favorites</a></p>
      </section>
    </GalleryLayout>,
    status,
  );
}

function bodyTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > MAX_FAVORITE_BODY_BYTES;
}

type BodyObject = Record<string, unknown>;

type ParseBodyResult =
  | { ok: true; value: BodyObject }
  | { ok: false; message: string; status: number };

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; message: string; status: number };

function isBodyObject(value: unknown): value is BodyObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Read at most the bounded mutation body, including when Content-Length is absent. */
async function readBody(request: Request): Promise<ReadBodyResult> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!chunk.value) continue;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_FAVORITE_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, message: "Request body is too large.", status: 413 };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The body is already unusable; preserve the original parse error.
    }
    return { ok: false, message: "Could not read the request body.", status: 400 };
  }
}

/** Parse the two body encodings emitted by enhanced controls and HTML forms. */
async function parseBody(request: Request): Promise<ParseBodyResult> {
  if (bodyTooLarge(request)) {
    return { ok: false, message: "Request body is too large.", status: 413 };
  }

  const body = await readBody(request);
  if (!body.ok) return body;
  const { text } = body;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();

  const looksLikeJson = contentType === undefined || contentType === ""
    ? text.trimStart().startsWith("{")
    : false;
  if (contentType === "application/json" || looksLikeJson) {
    if (text.trim() === "") return { ok: false, message: "Request body is required.", status: 400 };
    try {
      const parsed: unknown = JSON.parse(text);
      return isBodyObject(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, message: "Request body must be an object.", status: 400 };
    } catch {
      return { ok: false, message: "Request body must be valid JSON.", status: 400 };
    }
  }

  if (contentType !== undefined && contentType !== "" && contentType !== "application/x-www-form-urlencoded") {
    return { ok: false, message: "Use a JSON or URL-encoded request body.", status: 415 };
  }

  const fields = new URLSearchParams(text);
  const value: BodyObject = {};
  for (const [key, field] of fields.entries()) {
    // Duplicate scalar fields are ambiguous and should not silently select one
    // value. A caller that needs a desired state must send one explicit value.
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return { ok: false, message: `Field ${key} must appear only once.`, status: 400 };
    }
    value[key] = field;
  }
  return { ok: true, value };
}

function firstField(body: BodyObject, names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(body, name)) return body[name];
  }
  return undefined;
}

function desiredState(raw: unknown): FavoriteDesiredState | null {
  if (raw === "favorited" || raw === "unfavorited") return raw;
  // Boolean values are explicit desired states too. They are accepted for
  // fetch callers that naturally serialise a checked state as JSON, while a
  // blind `toggle` value remains invalid.
  if (raw === true || raw === false) return raw;
  if (raw === "true") return "favorited";
  if (raw === "false") return "unfavorited";
  return null;
}

type MutationInput = {
  photoId: number | null;
  desired: FavoriteDesiredState | null;
  returnTo: string;
  invalidReturnTo: boolean;
};

function mutationInput(body: BodyObject): MutationInput {
  const rawPhotoId = firstField(body, ["photoId", "photo_id", "photo", "id"]);
  const rawDesired = firstField(body, [
    "desiredState",
    "desired_state",
    "desired",
    "state",
    "favoriteState",
    "favorite_state",
    "favorited",
  ]);
  const rawReturnTo = firstField(body, ["return_to", "returnTo"]);
  const hasReturnTo = rawReturnTo !== undefined;
  const validReturnTo = !hasReturnTo || isSafeRelativePath(rawReturnTo);

  return {
    photoId: parseId(rawPhotoId),
    desired: desiredState(rawDesired),
    returnTo: safeRelativePath(rawReturnTo, "/favorites"),
    invalidReturnTo: !validReturnTo,
  };
}

function loginRedirect(request: Request, returnTo?: string): Response {
  const destination = safeRelativePath(returnTo, requestRelativePath(request, "/favorites"));
  return redirect(loginPath(destination));
}

function loginJson(request: Request, returnTo?: string): Response {
  const destination = safeRelativePath(returnTo, requestRelativePath(request, "/favorites"));
  const login = loginPath(destination);
  return jsonResponse({
    error: "Authentication required.",
    login,
    loginUrl: login,
  }, 401);
}

function isFavoritesRoot(request: Request): boolean {
  try {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    return pathname === "/favorites";
  } catch {
    return false;
  }
}

export function parseFavoritesPageParam(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : 1;
  }
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return Number.MAX_SAFE_INTEGER;
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function FavoritesBody({ page, userId }: { page: Awaited<ReturnType<typeof listFavoritePage>>; userId: number }) {
  return (
    <>
      <section class="mb-vsp-lg flex flex-col gap-vsp-2xs">
        <h1 class="text-display font-semibold tracking-tight">Favorites</h1>
        <p class="text-body text-ink-soft">
          {page.totalItems} {page.totalItems === 1 ? "favorite" : "favorites"}
        </p>
      </section>
      <PhotoFeed
        scope={favoritesFeedScope(userId)}
        page={page}
        nextHref={`/favorites/page/${page.page + 1}`}
        photos={page.items}
        empty={<EmptyState title="No favorites yet">Favorite a photo to find it here.</EmptyState>}
      />
    </>
  );
}

/** Render the authenticated collection or handle its root POST mutation. */
export async function renderFavoritesRoute(rawPage?: string): Promise<FavoritesRouteResult> {
  const { env, request } = getCloudflareContext<Env>();
  const json = wantsJsonResponse(request);

  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();
  if (request.method === "POST" && !isFavoritesRoot(request)) return methodNotAllowed();

  if (request.method === "POST") {
    const sessionUser = await getSessionUser(env, request);
    if (bodyTooLarge(request)) {
      if (!sessionUser) return json ? loginJson(request) : loginRedirect(request);
      return json
        ? jsonResponse({ error: "Request body is too large." }, 413)
        : htmlError("Request body is too large.", 413, layoutUser(sessionUser));
    }

    const parsedBody = await parseBody(request);
    // Authentication is checked before exposing any mutation details. A
    // malformed anonymous request still receives the useful auth boundary.
    if (!sessionUser) {
      let returnTo: string | undefined;
      if (parsedBody.ok) {
        const raw = firstField(parsedBody.value, ["return_to", "returnTo"]);
        if (isSafeRelativePath(raw)) returnTo = raw;
      }
      return json ? loginJson(request, returnTo) : loginRedirect(request, returnTo);
    }

    if (!parsedBody.ok) {
      return json
        ? jsonResponse({ error: parsedBody.message }, parsedBody.status)
        : htmlError(parsedBody.message, parsedBody.status, layoutUser(sessionUser));
    }

    const input = mutationInput(parsedBody.value);
    if (input.invalidReturnTo) {
      const message = "return_to must be a safe relative path.";
      return json
        ? jsonResponse({ error: message }, 400)
        : htmlError(message, 400, layoutUser(sessionUser));
    }
    if (input.photoId === null) {
      const message = "photoId must be a positive integer.";
      return json
        ? jsonResponse({ error: message }, 400)
        : htmlError(message, 400, layoutUser(sessionUser));
    }
    if (input.desired === null) {
      const message = "state must be favorited or unfavorited.";
      return json
        ? jsonResponse({ error: message }, 400)
        : htmlError(message, 400, layoutUser(sessionUser));
    }

    const result = await setFavoriteState(env, sessionUser.id, input.photoId, input.desired);
    if (result === null) {
      const message = "Photo not found.";
      return json
        ? jsonResponse({ error: message }, 404)
        : htmlError(message, 404, layoutUser(sessionUser));
    }

    if (json) return jsonResponse(result);
    return redirect(input.returnTo);
  }

  const sessionUser = await getSessionUser(env, request);
  if (!sessionUser) return loginRedirect(request);

  const page = await listFavoritePage(env, sessionUser.id, parseFavoritesPageParam(rawPage), sessionUser.id);
  const canonicalPath = page.page === 1 ? "/favorites" : `/favorites/page/${page.page}`;
  return (
    <GalleryLayout
      title="Favorites"
      activePath="/favorites"
      user={layoutUser(sessionUser)}
      seo={buildPageSeo({
        request,
        title: "Favorites",
        description: `Your favorite photos on ${SITE_NAME}.`,
        path: canonicalPath,
      })}
    >
      <FavoritesBody page={page} userId={sessionUser.id} />
    </GalleryLayout>
  );
}

export default function FavoritesPage(): Promise<FavoritesRouteResult> {
  return renderFavoritesRoute();
}
