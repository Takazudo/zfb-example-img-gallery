import { getCloudflareContext } from "@takazudo/zfb-adapter-cloudflare";
import { AuthForm } from "../components/auth-form";
import GalleryLayout from "../layouts/gallery-layout";
import {
  createSession,
  createUser,
  DuplicateUserError,
  getSessionUser,
  normalizeEmail,
  normalizeUsername,
  validateEmail,
  validatePassword,
  validateUsername,
} from "../lib/auth";
import { sessionCookie } from "../lib/cookies";
import type { Env } from "../lib/env";
import { htmlResponse, redirect } from "../lib/render";

export const prerender = false;

function page(
  values: { username?: string; email?: string },
  error?: string,
  status = 200,
): Response {
  return htmlResponse(
    <GalleryLayout title="Create an account" user={null}>
      <AuthForm mode="register" error={error} username={values.username} email={values.email} />
    </GalleryLayout>,
    status,
  );
}

export default async function RegisterPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();

  if (request.method !== "POST") {
    if (await getSessionUser(env, request)) return redirect("/");
    return page({});
  }

  const form = await request.formData();
  const username = normalizeUsername(String(form.get("username") ?? ""));
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");

  const invalid = validateUsername(username) ?? validateEmail(email) ?? validatePassword(password);
  if (invalid) return page({ username, email }, invalid, 400);

  try {
    const userId = await createUser(env, { username, email, password });
    const sessionId = await createSession(env, userId);
    return redirect("/", { "set-cookie": sessionCookie(sessionId) });
  } catch (err) {
    if (err instanceof DuplicateUserError) {
      const message =
        err.field === "email"
          ? "An account with that email already exists."
          : "That username is taken.";
      return page({ username, email }, message, 409);
    }
    throw err;
  }
}
