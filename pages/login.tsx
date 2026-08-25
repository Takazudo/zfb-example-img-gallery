import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { AuthForm } from "../components/auth-form";
import GalleryLayout from "../layouts/gallery-layout";
import {
  burnPasswordVerification,
  createSession,
  findCredentialsByEmail,
  getSessionUser,
  hashPassword,
  normalizeEmail,
  timingSafeEqual,
} from "../lib/auth";
import { sessionCookie } from "../lib/cookies";
import type { Env } from "../lib/env";
import { safeRelativePath } from "../lib/navigation";
import { htmlResponse, redirect } from "../lib/render";

export const prerender = false;

function page(values: { email?: string }, next = "/", error?: string, status = 200): Response {
  return htmlResponse(
    <GalleryLayout title="Sign in" user={null}>
      <AuthForm mode="login" error={error} email={values.email} next={next} />
    </GalleryLayout>,
    status,
  );
}

export default async function LoginPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();
  const requestUrl = new URL(request.url);
  const queryNext = requestUrl.searchParams.get("next");
  const requestedNext = safeRelativePath(queryNext, "/");

  if (request.method !== "POST") {
    if (await getSessionUser(env, request)) return redirect(requestedNext);
    return page({}, requestedNext);
  }

  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");
  // Prefer the hidden form value so a failed POST preserves the exact path
  // that was rendered by GET; query `next` remains a useful fallback for
  // clients that submit the form without that field.
  const next = safeRelativePath(form.get("next") ?? queryNext, "/");

  if (!email || !password) return page({ email }, next, "Enter your email and password.", 400);

  const invalid = "Email or password is incorrect.";
  const row = await findCredentialsByEmail(env, email);
  if (!row) {
    await burnPasswordVerification(password);
    return page({ email }, next, invalid, 401);
  }

  const candidate = await hashPassword(password, row.password_salt);
  if (!timingSafeEqual(candidate, row.password_hash)) return page({ email }, next, invalid, 401);

  const sessionId = await createSession(env, row.id);
  return redirect(next, { "set-cookie": sessionCookie(sessionId) });
}
