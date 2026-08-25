import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctx: null as unknown as { env: unknown; request: Request },
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.ctx,
}));

import LoginPage from "../../pages/login";
import LogoutPage from "../../pages/logout";
import RegisterPage from "../../pages/register";
import {
  getSessionUser,
  sqliteTimestamp,
} from "../../lib/auth";
import {
  clearedSessionCookie,
  readSessionId,
  sessionCookie,
} from "../../lib/cookies";
import type { AuthFakeEnv } from "../helpers/auth-fake-d1";
import { createFakeEnv } from "../helpers/auth-fake-d1";

let env: AuthFakeEnv;

beforeEach(() => {
  env = createFakeEnv();
});

function request(
  path: string,
  method: string,
  fields?: Record<string, string>,
  cookie?: string,
): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (fields) headers.set("content-type", "application/x-www-form-urlencoded");
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    body: fields ? new URLSearchParams(fields) : undefined,
  });
}

async function invoke(
  page: () => Promise<Response>,
  path: string,
  method: string,
  fields?: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  h.ctx = { env, request: request(path, method, fields, cookie) };
  return page();
}

async function register(fields: Record<string, string>): Promise<Response> {
  return invoke(RegisterPage, "/register", "POST", fields);
}

describe("authentication route handlers", () => {
  it("rejects an expired session from one hour ago and sweeps the row", async () => {
    env = createFakeEnv({
      users: [{
        id: 1,
        username: "expired",
        email: "expired@example.com",
        password_hash: "hash",
        password_salt: "salt",
        avatar_key: null,
        created_at: new Date().toISOString(),
      }],
      sessions: [{
        id: "expired-session",
        user_id: 1,
        created_at: new Date().toISOString(),
        expires_at: sqliteTimestamp(Date.now() - 60 * 60 * 1000),
      }],
    });

    const user = await getSessionUser(env, request("/", "GET", undefined, "sid=expired-session"));
    expect(user).toBeNull();
    expect(env.sessions).toHaveLength(0);
  });

  it("normalises email before uniqueness checks and storage", async () => {
    expect((await register({ username: "alice", email: "alice@example.com", password: "password1" })).status).toBe(303);
    const duplicate = await register({ username: "alice-two", email: " Alice@Example.COM ", password: "password1" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("An account with that email already exists.");
    expect(env.users[0].email).toBe("alice@example.com");
  });

  it("normalises username before uniqueness checks and storage", async () => {
    expect((await register({ username: "Takazudo", email: "one@example.com", password: "password1" })).status).toBe(303);
    const duplicate = await register({ username: " takazudo ", email: "two@example.com", password: "password1" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("That username is taken.");
    expect(env.users[0].username).toBe("takazudo");
  });

  it("enforces password minimum and maximum bounds", async () => {
    expect((await register({ username: "short", email: "short@example.com", password: "1234567" })).status).toBe(400);
    expect((await register({ username: "valid", email: "valid@example.com", password: "12345678" })).status).toBe(303);
    expect((await register({ username: "long", email: "long@example.com", password: "x".repeat(129) })).status).toBe(400);
  });

  it("uses the same 401 response for an unknown email and a wrong password", async () => {
    expect((await register({ username: "parity", email: "known@example.com", password: "password1" })).status).toBe(303);
    const unknown = await invoke(LoginPage, "/login", "POST", {
      email: "unknown@example.com",
      password: "password1",
    });
    const wrong = await invoke(LoginPage, "/login", "POST", {
      email: "known@example.com",
      password: "wrongpass",
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    const unknownBody = await unknown.text();
    const wrongBody = await wrong.text();
    const message = "Email or password is incorrect.";
    expect(unknownBody).toContain(message);
    expect(wrongBody).toContain(message);
    expect(unknownBody.match(new RegExp(message, "g"))).toHaveLength(1);
    expect(wrongBody.match(new RegExp(message, "g"))).toHaveLength(1);
  });

  it("round-trips a registration session through the sid cookie", async () => {
    const response = await register({ username: "roundtrip", email: "round@example.com", password: "password1" });
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toMatch(/^sid=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=604800$/);
    const sessionId = readSessionId(new Request("https://example.test/", { headers: { cookie: cookie ?? "" } }));
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    const user = await getSessionUser(env, request("/", "GET", undefined, cookie ?? ""));
    expect(user).toMatchObject({ id: 1, username: "roundtrip", email: "round@example.com", avatar_key: null });
  });

  it("serialises session cookies exactly", () => {
    expect(sessionCookie("abc")).toBe("sid=abc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800");
    expect(clearedSessionCookie()).toBe("sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  });

  it("allows only POST for logout and clears a session idempotently", async () => {
    expect((await invoke(LogoutPage, "/logout", "GET")).status).toBe(405);
    const getResponse = await invoke(LogoutPage, "/logout", "GET");
    expect(getResponse.headers.get("allow")).toBe("POST");

    const registered = await register({ username: "logout", email: "logout@example.com", password: "password1" });
    const cookie = registered.headers.get("set-cookie") ?? "";
    expect(env.sessions).toHaveLength(1);
    const response = await invoke(LogoutPage, "/logout", "POST", undefined, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBe("sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    expect(env.sessions).toHaveLength(0);

    const noSession = await invoke(LogoutPage, "/logout", "POST");
    expect(noSession.status).toBe(303);
    expect(noSession.headers.get("set-cookie")).toBe("sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  });

  it("redirects signed-in GET requests away from register and login", async () => {
    const registered = await register({ username: "signedin", email: "signedin@example.com", password: "password1" });
    const cookie = registered.headers.get("set-cookie") ?? "";
    const registerResponse = await invoke(RegisterPage, "/register", "GET", undefined, cookie);
    const loginResponse = await invoke(LoginPage, "/login", "GET", undefined, cookie);
    expect(registerResponse.status).toBe(303);
    expect(loginResponse.status).toBe(303);
    expect(registerResponse.headers.get("location")).toBe("/");
    expect(loginResponse.headers.get("location")).toBe("/");
  });

  it("preserves a safe login next path through validation errors and success", async () => {
    const get = await invoke(LoginPage, "/login?next=%2Ffavorites%2Fpage%2F2", "GET");
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('name="next" value="/favorites/page/2"');

    const invalid = await invoke(LoginPage, "/login?next=%2Ffavorites%2Fpage%2F2", "POST", {
      email: "alice@example.com",
      password: "",
      next: "/favorites/page/2",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('name="next" value="/favorites/page/2"');

    const registered = await register({ username: "next-user", email: "next@example.com", password: "password1" });
    expect(registered.status).toBe(303);
    const response = await invoke(LoginPage, "/login", "POST", {
      email: "next@example.com",
      password: "password1",
      next: "/favorites/page/2",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/favorites/page/2");
  });

  it("falls back to the root for unsafe login next values", async () => {
    const get = await invoke(LoginPage, "/login?next=https%3A%2F%2Fevil.example", "GET");
    expect(get.status).toBe(200);
    expect(await get.text()).not.toContain("evil.example");

    const response = await invoke(LoginPage, "/login", "POST", {
      email: "missing@example.com",
      password: "password1",
      next: "//evil.example/",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("evil.example");
  });
});
