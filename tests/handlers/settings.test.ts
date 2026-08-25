import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import type { SessionUser } from "../../lib/auth";
import { pngFixture } from "../helpers/mock-r2";

const h = vi.hoisted(() => ({
  current: null as null | { env: Env; request: Request },
  sessionUser: null as SessionUser | null,
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.current,
}));

vi.mock("../../lib/auth", () => ({
  getSessionUser: vi.fn(async () => h.sessionUser),
  validateUsername: (username: string) => {
    const length = [...username].length;
    if (length < 3 || length > 24) return "Username must be 3–24 characters.";
    return /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])$/.test(username)
      ? null
      : "Username may contain lowercase letters, digits, hyphen and underscore, and must start and end with a letter or digit.";
  },
}));

import SettingsPage from "../../pages/settings";

type UserRow = {
  id: number;
  username: string;
  email: string;
  avatar_key: string | null;
  created_at: string;
};

type PhotoRow = { id: number; user_id: number; r2_key: string; thumb_key: string | null };
type SessionRow = { id: string; user_id: number };

type BoundStatement = {
  sql: string;
  params: unknown[];
  bind: (...values: unknown[]) => BoundStatement;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: true; meta: { changes: number; last_row_id: number } }>;
};

class FakeD1 {
  users: UserRow[] = [];
  photos: PhotoRow[] = [];
  sessions: SessionRow[] = [];
  tags = [{ id: 1, name: "shared" }];
  mutationSql: string[] = [];
  batchSql: string[][] = [];
  failBatch = false;
  forceUsernameRace = false;

  readonly DB: D1Database;

  constructor() {
    this.DB = { prepare: (sql: string) => this.statement(sql) } as unknown as D1Database;
    (this.DB as unknown as { batch: (statements: BoundStatement[]) => Promise<unknown> }).batch = async (statements) => {
      this.batchSql.push(statements.map((statement) => statement.sql));
      if (this.failBatch) throw new Error("D1 batch failed");
      for (const statement of statements) this.applyDelete(statement.sql, statement.params);
      return { success: true };
    };
  }

  private statement(sql: string, params: unknown[] = []): BoundStatement {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      sql,
      params,
      bind: (...values) => this.statement(sql, values),
      first: async <T>() => {
        if (normalized.includes("select id, username, email, avatar_key, created_at from users")) {
          return (this.users.find((user) => user.id === Number(params[0])) ?? null) as T | null;
        }
        if (normalized.includes("select avatar_key from users")) {
          const user = this.users.find((candidate) => candidate.id === Number(params[0]));
          return (user ? { avatar_key: user.avatar_key } : null) as T | null;
        }
        if (normalized.includes("lower(username) = lower(?)")) {
          const wanted = String(params[0]).toLowerCase();
          const excluded = params.length > 1 ? Number(params[1]) : null;
          const found = this.users.some((user) => user.username.toLowerCase() === wanted && user.id !== excluded);
          return (found ? { found: 1 } : null) as T | null;
        }
        throw new Error(`Unsupported fake first query: ${sql}`);
      },
      all: async <T>() => {
        if (normalized.includes("select id, r2_key, thumb_key from photos")) {
          return { results: this.photos.filter((photo) => photo.user_id === Number(params[0])) as T[] };
        }
        throw new Error(`Unsupported fake all query: ${sql}`);
      },
      run: async () => {
        this.mutationSql.push(sql);
        if (normalized.startsWith("update users set username")) {
          if (this.forceUsernameRace) throw new Error("UNIQUE constraint failed: users.username");
          const user = this.users.find((candidate) => candidate.id === Number(params[1]));
          if (user) user.username = String(params[0]);
        } else if (normalized.startsWith("update users set avatar_key")) {
          const user = this.users.find((candidate) => candidate.id === Number(params[1]));
          if (user) user.avatar_key = params[0] === null ? null : String(params[0]);
        } else {
          throw new Error(`Unsupported fake run query: ${sql}`);
        }
        return { success: true, meta: { changes: 1, last_row_id: 0 } };
      },
    };
  }

  private applyDelete(sql: string, params: unknown[]): void {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    const userId = Number(params[0]);
    if (normalized.startsWith("delete from favorites")) return;
    if (normalized.startsWith("delete from photo_tags")) return;
    if (normalized.startsWith("delete from photos")) {
      this.photos = this.photos.filter((photo) => photo.user_id !== userId);
    } else if (normalized.startsWith("delete from sessions")) {
      this.sessions = this.sessions.filter((session) => session.user_id !== userId);
    } else if (normalized.startsWith("delete from users")) {
      this.users = this.users.filter((user) => user.id !== userId);
    }
  }
}

class FakeBucket {
  readonly store = new Map<string, Uint8Array>();
  readonly deleteBatches: string[][] = [];
  failDeleteAfterCalls = Number.POSITIVE_INFINITY;
  deleteCalls = 0;

  async put(key: string, value: unknown): Promise<void> {
    if (value instanceof ArrayBuffer) this.store.set(key, new Uint8Array(value.slice(0)));
    else if (ArrayBuffer.isView(value)) {
      this.store.set(key, new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
    } else if (value instanceof Blob) {
      this.store.set(key, new Uint8Array(await value.arrayBuffer()));
    } else {
      this.store.set(key, new Uint8Array());
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    const batch = Array.isArray(keys) ? [...keys] : [keys];
    this.deleteBatches.push(batch);
    this.deleteCalls += 1;
    if (this.deleteCalls > this.failDeleteAfterCalls) throw new Error("R2 delete failed");
    for (const key of batch) this.store.delete(key);
  }

  async list(options: { prefix?: string; delimiter?: string; cursor?: string } = {}) {
    const prefix = options.prefix ?? "";
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix));
    const delimitedPrefixes = options.delimiter
      ? [...new Set(keys.flatMap((key) => {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf(options.delimiter!);
        return slash < 0 ? [] : [`${prefix}${rest.slice(0, slash + 1)}`];
      }))]
      : [];
    return { objects: [], delimitedPrefixes, truncated: false as const };
  }
}

let fake: FakeD1;
let bucket: FakeBucket;
let env: Env;

function reset() {
  fake = new FakeD1();
  fake.users = [
    { id: 1, username: "alice", email: "alice@example.com", avatar_key: "avatars/old.png", created_at: "2026-08-22 00:00:00" },
    { id: 2, username: "bob", email: "bob@example.com", avatar_key: null, created_at: "2026-08-22 00:00:00" },
  ];
  fake.sessions = [{ id: "session-1", user_id: 1 }];
  bucket = new FakeBucket();
  env = { DB: fake.DB, BUCKET: bucket } as unknown as Env;
  h.sessionUser = { id: 1, username: "alice", email: "alice@example.com", avatar_key: "avatars/old.png" };
  h.current = null;
}

function request(method: string, body?: BodyInit, headers?: HeadersInit): Request {
  const requestHeaders = new Headers(headers);
  if (body instanceof URLSearchParams) requestHeaders.set("content-type", "application/x-www-form-urlencoded");
  return new Request("https://example.test/settings", { method, headers: requestHeaders, body });
}

async function invoke(method: string, body?: BodyInit, headers?: HeadersInit): Promise<Response> {
  h.current = { env, request: request(method, body, headers) };
  return SettingsPage();
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

function fileBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

beforeEach(reset);

describe("settings route", () => {
  it("gates GET by session, renders the account, and rejects other methods", async () => {
    h.sessionUser = null;
    expect((await invoke("GET")).status).toBe(303);
    expect((await invoke("GET")).headers.get("location")).toBe("/login");

    h.sessionUser = { id: 1, username: "alice", email: "alice@example.com", avatar_key: null };
    const signedIn = await invoke("GET");
    expect(signedIn.status).toBe(200);
    expect(await signedIn.text()).toContain('value="alice"');

    const put = await invoke("PUT");
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST");
  });

  it("rejects an oversized POST before parsing its body", async () => {
    const response = await invoke(
      "POST",
      form({ intent: "rename", username: "alice" }),
      { "content-length": String(4 * 1024 * 1024 + 1) },
    );
    expect(response.status).toBe(413);
    expect(fake.mutationSql).toEqual([]);
  });

  it("normalises successful renames and rejects invalid or taken names", async () => {
    const taken = await invoke("POST", form({ intent: "rename", username: " BOB " }));
    expect(taken.status).toBe(409);
    expect(fake.users[0].username).toBe("alice");

    const invalid = await invoke("POST", form({ intent: "rename", username: "no!" }));
    expect(invalid.status).toBe(400);

    const renamed = await invoke("POST", form({ intent: "rename", username: "  Ａbc  " }));
    expect(renamed.status).toBe(303);
    expect(fake.users[0].username).toBe("abc");
  });

  it("maps a concurrent username UNIQUE error to 409", async () => {
    fake.forceUsernameRace = true;
    const response = await invoke("POST", form({ intent: "rename", username: "charlie" }));
    expect(response.status).toBe(409);
    expect(fake.users[0].username).toBe("alice");
  });

  it("validates avatar bytes, replaces the key, and ignores old-key cleanup failures", async () => {
    const invalid = new FormData();
    invalid.set("intent", "avatar");
    invalid.set("avatar", new File([new Uint8Array([1, 2, 3])], "avatar.jpg", { type: "image/jpeg" }));
    expect((await invoke("POST", invalid)).status).toBe(415);
    expect(fake.users[0].avatar_key).toBe("avatars/old.png");

    const valid = new FormData();
    valid.set("intent", "avatar");
    valid.set("avatar", new File([fileBytes(pngFixture(96, 96))], "avatar.jpg", { type: "image/jpeg" }));
    const response = await invoke("POST", valid);
    expect(response.status).toBe(303);
    expect(fake.users[0].avatar_key).toMatch(/^avatars\//);
    expect(bucket.deleteBatches.flat()).toContain("avatars/old.png");

    reset();
    bucket.failDeleteAfterCalls = 0;
    const retry = new FormData();
    retry.set("intent", "avatar");
    retry.set("avatar", new File([fileBytes(pngFixture(96, 96))], "avatar.png", { type: "image/png" }));
    expect((await invoke("POST", retry)).status).toBe(303);
    expect(fake.users[0].avatar_key).toMatch(/^avatars\//);
  });

  it("does not touch storage or D1 mutation paths for a bad delete confirmation", async () => {
    const response = await invoke("POST", form({ intent: "delete", confirm: "not-alice" }));
    expect(response.status).toBe(400);
    expect(bucket.deleteBatches).toEqual([]);
    expect(fake.batchSql).toEqual([]);
  });

  it("deletes all account blobs and every listed OG generation before D1 rows", async () => {
    fake.photos = [
      { id: 7, user_id: 1, r2_key: "photos/7.jpg", thumb_key: "thumbs/7.jpg" },
      { id: 8, user_id: 1, r2_key: "photos/8.jpg", thumb_key: null },
      { id: 9, user_id: 2, r2_key: "photos/9.jpg", thumb_key: null },
    ];
    for (const key of [
      "avatars/old.png", "photos/7.jpg", "thumbs/7.jpg", "photos/8.jpg", "derived/og/v1/7.jpg",
      "derived/og/v1/8.jpg", "derived/og/v2/7.jpg", "derived/og/v2/8.jpg", "photos/9.jpg",
    ]) await bucket.put(key, new Uint8Array());

    const response = await invoke("POST", form({ intent: "delete", confirm: "ALICE" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toBe("sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    expect(bucket.store.has("photos/9.jpg")).toBe(true);
    expect([...bucket.store.keys()].some((key) => key.includes("/7.") || key.includes("/8."))).toBe(false);
    expect(fake.users.map((user) => user.id)).toEqual([2]);
    expect(fake.photos.map((photo) => photo.user_id)).toEqual([2]);
    expect(fake.sessions).toEqual([]);
    expect(fake.tags).toEqual([{ id: 1, name: "shared" }]);
    expect(fake.batchSql[0]).toHaveLength(5);
    expect(fake.batchSql[0]?.[0]).toContain("DELETE FROM favorites");
  });

  it("aborts before D1 when a later R2 batch fails, then succeeds on retry", async () => {
    fake.photos = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1,
      user_id: 1,
      r2_key: `photos/${index + 1}.jpg`,
      thumb_key: null,
    }));
    bucket.failDeleteAfterCalls = 1;

    const failed = await invoke("POST", form({ intent: "delete", confirm: "alice" }));
    expect(failed.status).toBe(503);
    expect(fake.batchSql).toEqual([]);
    expect(fake.users.some((user) => user.id === 1)).toBe(true);
    expect(fake.photos).toHaveLength(1001);
    expect(fake.sessions).toHaveLength(1);

    bucket.failDeleteAfterCalls = Number.POSITIVE_INFINITY;
    bucket.deleteCalls = 0;
    const healed = await invoke("POST", form({ intent: "delete", confirm: "alice" }));
    expect(healed.status).toBe(303);
    expect(fake.batchSql).toHaveLength(1);
    expect(fake.users.some((user) => user.id === 1)).toBe(false);
  });

  it("maps an atomic D1 cleanup failure to retryable account deletion", async () => {
    fake.photos = [{ id: 7, user_id: 1, r2_key: "photos/7.jpg", thumb_key: null }];
    fake.failBatch = true;
    const failed = await invoke("POST", form({ intent: "delete", confirm: "alice" }));
    expect(failed.status).toBe(503);
    expect(fake.users.some((user) => user.id === 1)).toBe(true);
    expect(fake.photos).toHaveLength(1);

    fake.failBatch = false;
    const retried = await invoke("POST", form({ intent: "delete", confirm: "alice" }));
    expect(retried.status).toBe(303);
    expect(fake.users.some((user) => user.id === 1)).toBe(false);
  });
});
