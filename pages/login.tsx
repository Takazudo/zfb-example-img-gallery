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
import { htmlResponse, redirect } from "../lib/render";

export const prerender = false;

function page(values: { email?: string }, error?: string, status = 200): Response {
  return htmlResponse(
    <GalleryLayout title="Sign in" user={null}>
      <AuthForm mode="login" error={error} email={values.email} />
    </GalleryLayout>,
    status,
  );
}

export default async function LoginPage(): Promise<Response> {
  const { env, request } = getCloudflareContext<Env>();

  if (request.method !== "POST") {
    if (await getSessionUser(env, request)) return redirect("/");
    return page({});
  }

  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const password = String(form.get("password") ?? "");

  if (!email || !password) return page({ email }, "Enter your email and password.", 400);

  const invalid = "Email or password is incorrect.";
  const row = await findCredentialsByEmail(env, email);
  if (!row) {
    await burnPasswordVerification(password);
    return page({ email }, invalid, 401);
  }

  const candidate = await hashPassword(password, row.password_salt);
  if (!timingSafeEqual(candidate, row.password_hash)) return page({ email }, invalid, 401);

  const sessionId = await createSession(env, row.id);
  return redirect("/", { "set-cookie": sessionCookie(sessionId) });
}
