import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { EmptyState } from "../components/empty-state";
import { PhotoFeed } from "../components/photo-feed";
import GalleryLayout, { type LayoutUser } from "../layouts/gallery-layout";
import { getSessionUser, type SessionUser } from "../lib/auth";
import {
  chunkD1Values,
  MAX_BULK_DELETE,
  parsePhotoIds,
  purgePhotos,
  type PhotoPurgeResult,
} from "../lib/db/photo-purge";
import { listUserPhotoPage } from "../lib/db/photos";
import type { Env } from "../lib/env";
import { loginPath, requestRelativePath, safeRelativePath, wantsJsonResponse } from "../lib/navigation";
import { htmlResponse, redirect } from "../lib/render";
import { buildPageSeo } from "../lib/seo";

export const prerender = false;

/** Keep the deletion body comfortably below Worker request-memory limits. */
export const MAX_DELETE_BODY_BYTES = 64 * 1024;

const INVALID_BATCH_MESSAGE = "We could not verify those photos. No photos were deleted.";
const RETRYABLE_DELETE_MESSAGE = "We could not delete those photos right now. Please try again.";
const UNREADABLE_BODY_MESSAGE = "We could not read that deletion request.";
const TOO_LARGE_BODY_MESSAGE = "That deletion request is too large.";
const LOGIN_MESSAGE = "Sign in to manage your photos.";

type DeletePayload = {
  ids: unknown[];
  returnTo: unknown;
  confirmed: boolean;
  cancel: boolean;
};

type OwnedPhotoSummary = { id: number; title: string };

/**
 * Route-local page parsing keeps malformed child paths deterministic. A huge
 * but otherwise numeric value intentionally means "last page"; the shared
 * read model clamps it after counting the authenticated user's photos.
 */
export function parseMyPhotosPage(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  if (page < 1) return 1;
  return Number.isSafeInteger(page) ? page : Number.MAX_SAFE_INTEGER;
}

function layoutUser(user: SessionUser): LayoutUser {
  return { username: user.username, avatarKey: user.avatar_key };
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

function bodyTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  return !Number.isSafeInteger(length) || length > MAX_DELETE_BODY_BYTES;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function isTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "confirm", "confirmed", "delete", "permanently"].includes(
    value.trim().toLowerCase(),
  );
}

function isCancellation(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "cancel", "cancelled", "canceled"].includes(value.trim().toLowerCase());
}

function isActionConfirmation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "confirm", "confirmed", "permanently"].includes(value.trim().toLowerCase());
}

function valueFromObject(object: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in object) return object[key];
  }
  return undefined;
}

function asIdValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function payloadFromJson(value: unknown): DeletePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const ids = valueFromObject(object, "photo_ids", "photoIds", "photo_id", "photoId", "ids");
  const action = valueFromObject(object, "action", "intent", "decision");
  const confirmation = valueFromObject(
    object,
    "confirmed",
    "confirm",
    "confirmation",
    "final_confirm",
    "final_confirmation",
    "finalConfirmation",
    "confirm_delete",
  );
  return {
    ids: asIdValues(ids),
    returnTo: valueFromObject(object, "return_to", "returnTo", "next"),
    confirmed: isTruthy(confirmation) || isActionConfirmation(action),
    cancel: isCancellation(valueFromObject(object, "cancel")) || isCancellation(action),
  };
}

type FormFields = {
  get(name: string): unknown;
  getAll(name: string): unknown[];
};

function payloadFromForm(form: FormFields): DeletePayload {
  const ids = form.getAll("photo_id");
  const aliases = ids.length > 0 ? ids : form.getAll("photo_ids");
  const action = form.get("action") ?? form.get("intent") ?? form.get("decision");
  const confirmation =
    form.get("confirmed")
    ?? form.get("confirm")
    ?? form.get("confirmation")
    ?? form.get("final_confirm")
    ?? form.get("final_confirmation")
    ?? form.get("confirm_delete");
  return {
    ids: aliases,
    returnTo: form.get("return_to") ?? form.get("returnTo") ?? form.get("next"),
    confirmed: isTruthy(confirmation) || isActionConfirmation(action),
    cancel: isCancellation(form.get("cancel")) || isCancellation(action),
  };
}

type ReadBodyResult =
  | { ok: true; text: string }
  | { ok: false; message: string; status: number };

type ReadPayloadResult =
  | { ok: true; payload: DeletePayload }
  | { ok: false; message: string; status: number };

/** Enforce the request limit while streaming, even without Content-Length. */
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
      if (bytesRead > MAX_DELETE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation remains authoritative if cancellation fails.
        }
        return { ok: false, message: TOO_LARGE_BODY_MESSAGE, status: 413 };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original body-read failure.
    }
    return { ok: false, message: UNREADABLE_BODY_MESSAGE, status: 400 };
  }
}

async function readPayload(request: Request): Promise<ReadPayloadResult> {
  if (bodyTooLarge(request)) {
    return { ok: false, message: TOO_LARGE_BODY_MESSAGE, status: 413 };
  }

  const body = await readBody(request);
  if (!body.ok) return body;

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const looksLikeJson = (contentType === undefined || contentType === "")
    && body.text.trimStart().startsWith("{");
  if (contentType === "application/json" || looksLikeJson) {
    try {
      const payload = payloadFromJson(JSON.parse(body.text));
      return payload === null
        ? { ok: false, message: UNREADABLE_BODY_MESSAGE, status: 400 }
        : { ok: true, payload };
    } catch {
      return { ok: false, message: UNREADABLE_BODY_MESSAGE, status: 400 };
    }
  }

  if (
    contentType !== undefined
    && contentType !== ""
    && contentType !== "application/x-www-form-urlencoded"
  ) {
    return {
      ok: false,
      message: "Use a JSON or URL-encoded deletion request.",
      status: 415,
    };
  }

  return { ok: true, payload: payloadFromForm(new URLSearchParams(body.text)) };
}

/**
 * Accept only a same-origin relative path. Rejecting backslashes and control
 * characters closes browser URL-parser/open-redirect edge cases before the
 * value reaches a Location header.
 */
export function safeReturnPath(raw: unknown, request: Request, fallback = "/my-photos"): string {
  const safe = safeRelativePath(raw, fallback);

  try {
    const candidate = new URL(safe, request.url);
    if (candidate.origin !== new URL(request.url).origin) return fallback;
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return fallback;
  }
}

function safeDeletionTarget(path: string, ids: readonly number[]): string {
  try {
    const pathname = new URL(path, "https://my-photos.invalid").pathname.replace(/\/+$/, "");
    if (ids.some((id) => pathname === `/photos/${id}`)) return "/my-photos";
  } catch {
    return "/my-photos";
  }
  return path;
}

async function resolveOwnedPhotoSummaries(
  env: Env,
  userId: number,
  ids: readonly number[],
): Promise<OwnedPhotoSummary[] | null> {
  const rows: OwnedPhotoSummary[] = [];
  for (const chunk of chunkD1Values(ids, 1)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await env.DB
      .prepare(
        `SELECT id, title
           FROM photos
          WHERE user_id = ? AND id IN (${placeholders})`,
      )
      .bind(userId, ...chunk)
      .all<OwnedPhotoSummary>();
    rows.push(...result.results);
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) return null;
  return ids.map((id) => byId.get(id)!);
}

function renderRouteError(
  request: Request,
  user: SessionUser,
  message: string,
  status: number,
  returnTo = "/my-photos",
  asJson = false,
): Response {
  if (asJson) return jsonError(message, status);
  return htmlResponse(
    <GalleryLayout
      title="My Photos"
      activePath="/my-photos"
      user={layoutUser(user)}
      seo={buildPageSeo({ request, title: "My Photos", path: "/my-photos" })}
    >
      <section data-delete-error class="mx-auto flex w-full max-w-[42rem] flex-col gap-vsp-sm">
        <h1 class="text-title font-semibold tracking-tight">My Photos</h1>
        <p role="alert" class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger">
          {message}
        </p>
        <p><a class="text-brand underline hover:text-brand-strong" href={returnTo}>Return to My Photos</a></p>
      </section>
    </GalleryLayout>,
    status,
  );
}

function ConfirmationPage({
  request,
  user,
  ids,
  summaries,
  returnTo,
}: {
  request: Request;
  user: SessionUser;
  ids: number[];
  summaries: OwnedPhotoSummary[];
  returnTo: string;
}): Response {
  const single = ids.length === 1;
  return htmlResponse(
    <GalleryLayout
      title="Confirm deletion"
      activePath="/my-photos"
      user={layoutUser(user)}
      seo={buildPageSeo({ request, title: "Confirm deletion", path: "/my-photos" })}
    >
      <section
        data-delete-confirmation
        class="mx-auto flex w-full max-w-[42rem] flex-col gap-vsp-md rounded-lg border border-danger bg-danger-soft p-hsp-lg"
      >
        <div class="flex flex-col gap-vsp-2xs">
          <p class="text-micro font-semibold uppercase tracking-widest text-danger">Permanent action</p>
          <h1 class="text-title font-semibold tracking-tight">Confirm deletion</h1>
          <p class="text-body text-ink">
            {single
              ? <>Delete <strong>{summaries[0]?.title ?? "this photo"}</strong> permanently?</>
              : `Delete ${ids.length} photos permanently?`}
          </p>
          <p class="text-small text-ink-soft">This cannot be undone.</p>
        </div>

        <form method="post" action="/my-photos" class="flex flex-wrap gap-hsp-sm">
          {ids.map((id) => <input key={id} type="hidden" name="photo_id" value={String(id)} />)}
          <input type="hidden" name="return_to" value={returnTo} />
          <input type="hidden" name="confirmed" value="1" />
          <button
            type="submit"
            class="inline-flex min-h-[2.75rem] items-center rounded-md bg-danger px-hsp-sm text-small font-semibold text-on-danger transition-colors hover:bg-danger-strong"
          >
            Delete permanently
          </button>
        </form>

        <form method="post" action="/my-photos">
          {ids.map((id) => <input key={id} type="hidden" name="photo_id" value={String(id)} />)}
          <input type="hidden" name="return_to" value={returnTo} />
          <button
            type="submit"
            name="cancel"
            value="1"
            class="inline-flex min-h-[2.75rem] items-center rounded-md border border-line-strong px-hsp-sm text-small text-ink transition-colors hover:bg-surface"
          >
            Cancel
          </button>
        </form>
      </section>
    </GalleryLayout>,
    200,
  );
}

function purgeFailure(
  result: Extract<PhotoPurgeResult, { ok: false }>,
): { message: string; status: number } {
  switch (result.reason) {
    case "invalid-or-unauthorized":
      return { message: INVALID_BATCH_MESSAGE, status: 400 };
    case "r2-delete-failed":
    case "d1-delete-failed":
      return { message: RETRYABLE_DELETE_MESSAGE, status: 503 };
  }
}

function renderCollection(request: Request, user: SessionUser, result: Awaited<ReturnType<typeof listUserPhotoPage>>): Response {
  const canonicalPath = result.page === 1 ? "/my-photos" : `/my-photos/page/${result.page}`;
  const nextHref = `/my-photos/page/${result.page + 1}`;
  return htmlResponse(
    <GalleryLayout
      title={result.page === 1 ? "My Photos" : `My Photos — Page ${result.page}`}
      activePath="/my-photos"
      user={layoutUser(user)}
      seo={buildPageSeo({
        request,
        title: result.page === 1 ? "My Photos" : `My Photos — Page ${result.page}`,
        description: "Browse the photos you have uploaded to Stillframe.",
        path: canonicalPath,
      })}
    >
      <section class="flex flex-col gap-vsp-md">
        <div class="flex flex-col gap-vsp-2xs">
          <p class="text-micro font-semibold uppercase tracking-widest text-brand">Personal collection</p>
          <h1 class="text-display font-semibold tracking-tight">My Photos</h1>
          <p class="text-body text-ink-soft">Photos you have uploaded to Stillframe.</p>
        </div>
        <div data-photo-selection-toolbar="true" class="photo-selection-toolbar">
          <p data-photo-selected-count="true" aria-live="polite" aria-atomic="true">0 photos selected</p>
          <div class="flex flex-wrap gap-hsp-xs">
            <button type="button" data-photo-select-all="true" class="photo-toolbar-action">Select all loaded (up to {MAX_BULK_DELETE})</button>
            <button type="button" data-photo-clear="true" class="photo-toolbar-action" disabled>Clear</button>
            <form id="photo-bulk-delete-form" data-photo-bulk-delete-form="true" action="/my-photos" method="post">
              <input type="hidden" name="return_to" value={canonicalPath} />
              <button type="submit" data-photo-bulk-delete="true" class="photo-toolbar-delete" disabled>Delete selected</button>
            </form>
          </div>
          <p class="text-micro text-ink-soft">You can delete up to {MAX_BULK_DELETE} loaded photos per operation.</p>
        </div>
        <PhotoFeed
          scope={`my-photos:${user.id}`}
          page={result}
          nextHref={nextHref}
          photos={result.items}
          viewerId={user.id}
          returnTo={canonicalPath}
          selectable
          empty={result.totalItems === 0 ? (
            <EmptyState title="No photos yet" action={{ href: "/upload", label: "Upload a photo" }}>
              Upload your first photo to start your personal collection.
            </EmptyState>
          ) : null}
        />
      </section>
    </GalleryLayout>,
  );
}

async function handlePost(request: Request, env: Env, user: SessionUser): Promise<Response> {
  const asJson = wantsJsonResponse(request);

  const parsedPayload = await readPayload(request);
  if (!parsedPayload.ok) {
    return renderRouteError(
      request,
      user,
      parsedPayload.message,
      parsedPayload.status,
      "/my-photos",
      asJson,
    );
  }
  const { payload } = parsedPayload;

  const returnTo = safeReturnPath(payload.returnTo, request);
  if (payload.cancel) {
    if (asJson) return jsonResponse({ cancelled: true, redirectTo: returnTo });
    return redirect(returnTo);
  }

  const parsed = parsePhotoIds(payload.ids);
  if (!parsed.ok) {
    return renderRouteError(request, user, INVALID_BATCH_MESSAGE, 400, "/my-photos", asJson);
  }

  if (!payload.confirmed) {
    if (asJson) return jsonError("Explicit confirmation is required before deletion.", 400);
    let summaries: OwnedPhotoSummary[] | null;
    try {
      summaries = await resolveOwnedPhotoSummaries(env, user.id, parsed.ids);
    } catch {
      return renderRouteError(request, user, RETRYABLE_DELETE_MESSAGE, 503, returnTo);
    }
    if (summaries === null) {
      return renderRouteError(request, user, INVALID_BATCH_MESSAGE, 400, "/my-photos");
    }
    return ConfirmationPage({ request, user, ids: parsed.ids, summaries, returnTo });
  }

  let result: PhotoPurgeResult;
  try {
    // Pass the already validated/deduplicated ids. The purge service performs
    // its own defensive parse and, critically, re-resolves ownership again.
    result = await purgePhotos(env, user.id, parsed.ids);
  } catch {
    return renderRouteError(request, user, RETRYABLE_DELETE_MESSAGE, 503, returnTo, asJson);
  }
  if (!result.ok) {
    const failure = purgeFailure(result);
    const failureTarget = result.reason === "invalid-or-unauthorized" ? "/my-photos" : returnTo;
    return renderRouteError(request, user, failure.message, failure.status, failureTarget, asJson);
  }

  const target = safeDeletionTarget(returnTo, result.deletedIds);
  if (asJson) {
    return jsonResponse({
      deletedIds: result.deletedIds,
      redirectTo: target,
    });
  }
  return redirect(target);
}

/** Shared handler for the bare My Photos route and its canonical child pages. */
export async function renderMyPhotosPage(rawPage: unknown = 1): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();

  const sessionUser = await getSessionUser(env, request);
  if (!sessionUser) {
    const login = loginPath(requestRelativePath(request, "/my-photos"));
    if (request.method === "POST" && wantsJsonResponse(request)) {
      return jsonResponse({ error: LOGIN_MESSAGE, login, loginUrl: login }, 401);
    }
    return redirect(login);
  }

  if (request.method === "POST") return handlePost(request, env, sessionUser);

  const result = await listUserPhotoPage(env, sessionUser.id, parseMyPhotosPage(rawPage), sessionUser.id);
  return renderCollection(request, sessionUser, result);
}

export default function MyPhotosPage(): Promise<Response> {
  return renderMyPhotosPage(1);
}
