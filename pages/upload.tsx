import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { Button } from "../components/button";
import { Field } from "../components/field";
import {
  getSessionUser,
  type SessionUser,
} from "../lib/auth";
import type { Env } from "../lib/env";
import * as og from "../lib/og";
import { buildPageSeo } from "../lib/seo";
import { htmlResponse, redirect } from "../lib/render";
import {
  deleteObjects,
  MAX_UPLOAD_BYTES,
  preprocessAndStorePhoto,
  type PhotoStoreResult,
} from "../lib/storage";
import { insertPhoto } from "../lib/db/photo-write";
import { normalizeTagInput } from "../lib/db/tags";
import GalleryLayout from "../layouts/gallery-layout";

export const prerender = false;

const MAX_MULTIPART_BODY = MAX_UPLOAD_BYTES + 64 * 1024;

type FormValues = {
  title: string;
  description: string;
  tags: string;
};

type RenderOptions = {
  request: Request;
  user: SessionUser;
  values?: Partial<FormValues>;
  error?: string;
  status?: number;
  photoReselect?: boolean;
};

const EMPTY_VALUES: FormValues = { title: "", description: "", tags: "" };

function normaliseNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function fieldText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function codePointLength(value: string): number {
  return [...value].length;
}

function layoutUser(user: SessionUser): { username: string; avatarKey: string | null } {
  return { username: user.username, avatarKey: user.avatar_key };
}

function renderPage({
  request,
  user,
  values = EMPTY_VALUES,
  error,
  status = 200,
  photoReselect = false,
}: RenderOptions): Response {
  const formValues = { ...EMPTY_VALUES, ...values };
  return htmlResponse(
    <GalleryLayout
      title="Upload a photo"
      activePath="/upload"
      user={layoutUser(user)}
      seo={buildPageSeo({ request, title: "Upload a photo" })}
    >
      <section class="mx-auto flex w-full max-w-[42rem] flex-col gap-vsp-md">
        <div class="flex flex-col gap-vsp-2xs">
          <p class="text-micro font-semibold uppercase tracking-widest text-brand">Stillframe</p>
          <h1 class="text-title font-semibold tracking-tight">Upload a photo</h1>
          <p class="text-small text-ink-soft">
            Add a photograph to your gallery. Files are checked by their bytes before they are stored.
          </p>
        </div>

        <form
          method="post"
          action="/upload"
          encType="multipart/form-data"
          class="flex flex-col gap-vsp-md rounded-lg border border-line bg-surface p-hsp-lg shadow-card"
        >
          {error ? (
            <p role="alert" class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger">
              {error}
            </p>
          ) : null}

          {photoReselect ? (
            <p class="rounded-md border border-line bg-surface-sunken px-hsp-sm py-vsp-xs text-small text-ink-soft">
              Please select the photo again; browsers cannot repopulate file inputs after a failed submission.
            </p>
          ) : null}

          <Field
            id="photo"
            name="photo"
            label="Photo"
            type="file"
            required
            accept="image/jpeg,image/png,image/webp"
            hint="JPEG, PNG or WebP, up to 4 MB."
          />
          <Field
            id="title"
            name="title"
            label="Title"
            value={formValues.title}
            required
            maxLength={120}
            placeholder="Untitled study"
          />
          <Field
            id="description"
            name="description"
            label="Description"
            as="textarea"
            rows={7}
            value={formValues.description}
            hint="Optional plain text, up to 2000 characters."
          />
          <Field
            id="tags"
            name="tags"
            label="Tags"
            value={formValues.tags}
            hint="comma separated, up to 10 tags"
          />

          <Button>Upload photo</Button>
        </form>
      </section>
    </GalleryLayout>,
    status,
  );
}

function contentLengthOverLimit(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return false;
  const length = Number(raw);
  return !Number.isFinite(length) || length > MAX_MULTIPART_BODY;
}

function storageReason(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : null;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("too-large") || message.includes("too large")) return "too-large";
    if (message.includes("unsupported") || message.includes("format") || message.includes("type")) {
      return "unsupported-type";
    }
    if (message.includes("undecodable") || message.includes("decode")) return "undecodable";
    if (message.includes("empty") || message.includes("zero")) return "empty";
  }
  return null;
}

function storageFailure(reason: string): { message: string; status: number } {
  switch (reason) {
    case "empty":
      return { message: "Choose a non-empty photo file.", status: 400 };
    case "too-large":
      return { message: "That photo is larger than 4 MB.", status: 413 };
    case "unsupported-type":
      return { message: "That file is not a supported JPEG, PNG or WebP image.", status: 415 };
    case "undecodable":
      return { message: "That image header could not be decoded.", status: 415 };
    default:
      return { message: "Could not store your photo, please try again.", status: 500 };
  }
}

function resultFailure(result: Extract<PhotoStoreResult, { ok: false }>): { message: string; status: number } {
  return storageFailure(result.reason);
}

function formValuesFrom(rawTitle: string, rawDescription: string, rawTags: string): FormValues {
  return { title: rawTitle, description: rawDescription, tags: rawTags };
}

export default async function UploadPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const user = await getSessionUser(env, request);
  if (!user) return redirect("/login");

  if (request.method !== "POST") {
    return renderPage({ request, user });
  }

  if (contentLengthOverLimit(request)) {
    return renderPage({
      request,
      user,
      error: "That upload request is too large.",
      status: 413,
      photoReselect: true,
    });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return renderPage({
      request,
      user,
      error: "We could not read that upload request.",
      status: 400,
      photoReselect: true,
    });
  }

  const rawTitle = normaliseNewlines(fieldText(form, "title"));
  const rawDescription = normaliseNewlines(fieldText(form, "description"));
  const rawTags = fieldText(form, "tags");
  const values = formValuesFrom(rawTitle, rawDescription, rawTags);
  const title = rawTitle.trim();
  const description = rawDescription.trim();

  if (title === "") {
    return renderPage({ request, user, values, error: "Title is required.", status: 400, photoReselect: true });
  }
  if (codePointLength(title) > 120) {
    return renderPage({
      request,
      user,
      values,
      error: "Title must be at most 120 characters.",
      status: 400,
      photoReselect: true,
    });
  }
  if (codePointLength(description) > 2000) {
    return renderPage({
      request,
      user,
      values,
      error: "Description must be at most 2000 characters.",
      status: 400,
      photoReselect: true,
    });
  }

  const parsedTags = normalizeTagInput(rawTags);
  if (parsedTags.rejected.length > 0) {
    const offending = parsedTags.rejected[0];
    return renderPage({
      request,
      user,
      values,
      error: `Tag "${offending}" is invalid. Use up to 10 tags, each 1–32 characters without /, %, ?, # or control characters.`,
      status: 400,
      photoReselect: true,
    });
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return renderPage({
      request,
      user,
      values,
      error: "Choose a non-empty photo file.",
      status: 400,
      photoReselect: true,
    });
  }

  let stored: PhotoStoreResult;
  try {
    stored = await preprocessAndStorePhoto(env, await photo.arrayBuffer());
  } catch (error) {
    const reason = storageReason(error);
    const failure = storageFailure(reason ?? "store-failed");
    return renderPage({ request, user, values, error: failure.message, status: failure.status, photoReselect: true });
  }

  if (!stored.ok) {
    const failure = resultFailure(stored);
    return renderPage({ request, user, values, error: failure.message, status: failure.status, photoReselect: true });
  }

  let photoId: number;
  try {
    photoId = await insertPhoto(env, {
      userId: user.id,
      title,
      description,
      r2Key: stored.key,
      contentType: stored.contentType,
      width: stored.width,
      height: stored.height,
      blurhash: stored.blurhash,
      tags: parsedTags.tags,
    });
  } catch {
    try {
      await deleteObjects(env, [stored.key]);
    } catch {
      // Cleanup is best effort; never replace the user-facing D1 failure.
    }
    return renderPage({
      request,
      user,
      values,
      error: "Could not save your photo, please try again.",
      status: 500,
      photoReselect: true,
    });
  }

  try {
    // The merged OG module persists through ensureOgCard. The fallback keeps
    // this route compatible with the issue's narrow generateOgCard test mock.
    const ensure = "ensureOgCard" in og ? og.ensureOgCard : undefined;
    const generate = "generateOgCard" in og ? og.generateOgCard : undefined;
    if (typeof ensure === "function") {
      await ensure(env, String(photoId), stored.key);
    } else if (typeof generate === "function") {
      await generate(env, String(photoId));
    }
  } catch {
    // A card miss is regenerated lazily by /og/v1; it must never lose an upload.
  }

  return redirect(`/photos/${photoId}`);
}
