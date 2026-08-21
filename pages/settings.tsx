/*
 * Every mutation here is POST-only on purpose. SameSite=Lax sends the sid
 * cookie on a top-level cross-site GET, but not on a cross-site POST, so a
 * destructive GET would be CSRF-able without a client-side token or Origin
 * check. This is the app's deliberate CSRF boundary.
 */

import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { Button } from "../components/button";
import { Field } from "../components/field";
import GalleryLayout from "../layouts/gallery-layout";
import { getSessionUser, validateUsername } from "../lib/auth";
import { clearedSessionCookie } from "../lib/cookies";
import type { Env } from "../lib/env";
import {
  getAccount,
  isUsernameTaken,
  normalizeUsername,
  purgeAccount,
  updateAvatarKey,
  updateUsername,
} from "../lib/db/account";
import { htmlResponse, redirect } from "../lib/render";
import {
  contentLengthExceedsLimit,
  validateAndStore,
  type StoreResult,
} from "../lib/storage";
import type { AccountUser } from "../lib/db/account";
import type { SessionUser } from "../lib/auth";

export const prerender = false;

type Errors = {
  rename?: string;
  avatar?: string;
  deletion?: string;
  general?: string;
};

type Values = {
  username?: string;
  confirm?: string;
};

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: {
      allow: "GET, POST",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function avatarStoreError(result: Extract<StoreResult, { ok: false }>): { message: string; status: number } {
  switch (result.reason) {
    case "empty":
      return { message: "Choose an image to upload.", status: 400 };
    case "too-large":
      return { message: "Avatar images must be 4 MB or smaller.", status: 413 };
    case "unsupported-type":
    case "undecodable":
      return { message: "Avatar must be a valid JPEG, PNG, or WebP image.", status: 415 };
  }
}

function Alert({ children }: { children: string }) {
  return (
    <p role="alert" class="rounded-md border border-danger bg-danger-soft px-hsp-sm py-vsp-xs text-small text-danger">
      {children}
    </p>
  );
}

export function SettingsView({
  account,
  sessionUser,
  errors = {},
  values = {},
}: {
  account: AccountUser;
  sessionUser: SessionUser;
  errors?: Errors;
  values?: Values;
}) {
  const username = values.username ?? account.username;
  const confirm = values.confirm ?? "";
  const avatarUrl = account.avatar_key ? `/img/${account.avatar_key}` : null;

  return (
    <GalleryLayout
      title="Settings"
      user={{ username: sessionUser.username, avatarKey: account.avatar_key }}
      activePath="/settings"
    >
      <section class="mx-auto flex w-full max-w-[36rem] flex-col gap-vsp-lg">
        <div class="flex flex-col gap-vsp-2xs">
          <p class="text-micro font-semibold uppercase tracking-widest text-brand">Account</p>
          <h1 class="text-title font-semibold tracking-tight">Settings</h1>
          <p class="text-small text-ink-soft">Update your public identity, avatar, or account data.</p>
        </div>

        <form
          method="post"
          action="/settings"
          class="flex flex-col gap-vsp-md rounded-lg border border-line bg-surface p-hsp-lg shadow-card"
        >
          <input type="hidden" name="intent" value="rename" />
          {errors.rename ? <Alert>{errors.rename}</Alert> : null}
          <Field
            id="username"
            name="username"
            label="Username"
            value={username}
            required
            maxLength={24}
            autoComplete="username"
            hint="3–24 lowercase letters, digits, hyphen, or underscore."
          />
          <p class="text-small text-ink-soft">This is shown publicly as @{account.username}.</p>
          <Button>Save username</Button>
        </form>

        <form
          method="post"
          action="/settings"
          enctype="multipart/form-data"
          class="flex flex-col gap-vsp-md rounded-lg border border-line bg-surface p-hsp-lg shadow-card"
        >
          <input type="hidden" name="intent" value="avatar" />
          {errors.avatar ? <Alert>{errors.avatar}</Alert> : null}
          <div class="flex items-center gap-hsp-md">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={`@${account.username}'s avatar`}
                width={96}
                height={96}
                class="size-24 rounded-pill object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                class="inline-flex size-24 items-center justify-center rounded-pill bg-surface-sunken text-title font-semibold text-ink"
              >
                {account.username.charAt(0).toUpperCase()}
              </div>
            )}
            <p class="text-small text-ink-soft">Your avatar is shown beside your public username.</p>
          </div>
          <Field
            id="avatar"
            name="avatar"
            label="Avatar image"
            type="file"
            required
            accept="image/jpeg,image/png,image/webp"
            hint="JPEG, PNG, or WebP. Maximum 4 MB."
          />
          <Button>Replace avatar</Button>
        </form>

        <section class="flex flex-col gap-vsp-md rounded-lg border border-danger bg-danger-soft p-hsp-lg">
          <div class="flex flex-col gap-vsp-2xs">
            <h2 class="text-heading font-semibold text-danger">Danger zone</h2>
            <p class="text-small text-ink-soft">
              Permanently delete your account, photos, avatars, and generated social cards. This cannot be undone.
            </p>
          </div>
          <form method="post" action="/settings" class="flex flex-col gap-vsp-md">
            <input type="hidden" name="intent" value="delete" />
            {errors.deletion ? <Alert>{errors.deletion}</Alert> : null}
            <Field
              id="confirm"
              name="confirm"
              label={`Type ${account.username} to confirm account deletion`}
              value={confirm}
              required
              autoComplete="off"
            />
            <Button variant="danger">Delete account permanently</Button>
          </form>
        </section>

        {errors.general ? <Alert>{errors.general}</Alert> : null}
      </section>
    </GalleryLayout>
  );
}

function page(
  account: AccountUser,
  sessionUser: SessionUser,
  errors: Errors = {},
  values: Values = {},
  status = 200,
): Response {
  return htmlResponse(<SettingsView account={account} sessionUser={sessionUser} errors={errors} values={values} />, status);
}

export default async function SettingsPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();

  if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed();

  const sessionUser = await getSessionUser(env, request);
  if (!sessionUser) return redirect("/login");

  const account = await getAccount(env.DB, sessionUser.id);
  if (!account) return redirect("/login", { "set-cookie": clearedSessionCookie() });

  if (request.method === "GET") return page(account, sessionUser);

  // Reject before formData() for every intent, including tiny rename/delete
  // forms, so an untrusted body cannot exceed the Worker memory budget.
  if (contentLengthExceedsLimit(request)) {
    return page(account, sessionUser, { general: "Request body is too large. Maximum size is 4 MB." }, {}, 413);
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "rename") {
    const submitted = String(form.get("username") ?? "");
    const username = normalizeUsername(submitted);
    const invalid = validateUsername(username);
    if (invalid) return page(account, sessionUser, { rename: invalid }, { username: submitted }, 400);

    if (await isUsernameTaken(env.DB, username, sessionUser.id)) {
      return page(account, sessionUser, { rename: "That username is already taken." }, { username: submitted }, 409);
    }
    if (!(await updateUsername(env.DB, sessionUser.id, username))) {
      return page(account, sessionUser, { rename: "That username is already taken." }, { username: submitted }, 409);
    }
    return redirect("/settings");
  }

  if (intent === "avatar") {
    const value = form.get("avatar");
    if (!value || typeof value !== "object" || typeof (value as Blob).arrayBuffer !== "function") {
      return page(account, sessionUser, { avatar: "Choose an image to upload." }, {}, 400);
    }

    const result = await validateAndStore(env, await (value as Blob).arrayBuffer(), { prefix: "avatars" });
    if (!result.ok) {
      const error = avatarStoreError(result);
      return page(account, sessionUser, { avatar: error.message }, {}, error.status);
    }

    const previousKey = await updateAvatarKey(env.DB, sessionUser.id, result.key);
    if (previousKey && previousKey !== result.key) {
      try {
        await env.BUCKET.delete(previousKey);
      } catch {
        // The new row already points at a valid object; a failed cleanup only
        // leaves an orphan and must not turn a successful replacement into an error.
      }
    }
    return redirect("/settings");
  }

  if (intent === "delete") {
    const confirmation = normalizeUsername(String(form.get("confirm") ?? ""));
    if (confirmation !== account.username) {
      return page(account, sessionUser, { deletion: `Type ${account.username} exactly to confirm deletion.` }, { confirm: String(form.get("confirm") ?? "") }, 400);
    }

    const result = await purgeAccount(env, sessionUser.id);
    if (!result.ok) {
      return page(account, sessionUser, { deletion: "Some account files could not be removed. Please retry." }, {}, 503);
    }
    return redirect("/", { "set-cookie": clearedSessionCookie() });
  }

  return methodNotAllowed();
}
