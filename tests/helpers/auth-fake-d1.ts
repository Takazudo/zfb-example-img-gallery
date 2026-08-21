import type { Env } from "../../lib/env";

export interface FakeUser {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  password_salt: string;
  avatar_key: string | null;
  created_at: string;
}

export interface FakeSession {
  id: string;
  user_id: number;
  created_at: string;
  expires_at: string;
}

export interface AuthFakeEnv extends Env {
  users: FakeUser[];
  sessions: FakeSession[];
}

type FakeEnvOptions = {
  users?: FakeUser[];
  sessions?: FakeSession[];
};

function epoch(value: string): number {
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const sqlite = value.replace(" ", "T");
  return Date.parse(sqlite.endsWith("Z") ? sqlite : `${sqlite}Z`);
}

function isLive(expiresAt: string): boolean {
  return epoch(expiresAt) > Date.now();
}

export function createFakeEnv(options: FakeEnvOptions = {}): AuthFakeEnv {
  const users = options.users ?? [];
  const sessions = options.sessions ?? [];

  function makeStatement(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      bind(...values: unknown[]) {
        return makeStatement(sql, values);
      },
      async first<T>(): Promise<T | null> {
        if (normalized.includes("from users where email")) {
          const email = String(params[0]);
          const user = users.find((candidate) => candidate.email === email);
          if (!user) return null;
          return {
            id: user.id,
            password_hash: user.password_hash,
            password_salt: user.password_salt,
          } as T;
        }

        if (normalized.includes("where username = ? or email = ?")) {
          const username = String(params[0]);
          const email = String(params[1]);
          const user = users.find((candidate) => candidate.username === username || candidate.email === email);
          if (!user) return null;
          return { username: user.username, email: user.email } as T;
        }

        if (normalized.includes("from sessions")) {
          const sessionId = String(params[0]);
          const session = sessions.find((candidate) => candidate.id === sessionId && isLive(candidate.expires_at));
          if (!session) return null;
          const user = users.find((candidate) => candidate.id === session.user_id);
          if (!user) return null;
          return {
            id: user.id,
            username: user.username,
            email: user.email,
            avatar_key: user.avatar_key,
          } as T;
        }

        throw new Error(`Unsupported fake D1 first query: ${sql}`);
      },
      async run() {
        if (normalized.startsWith("insert into users")) {
          const username = String(params[0]);
          const email = String(params[1]);
          if (users.some((candidate) => candidate.email === email)) {
            throw new Error("UNIQUE constraint failed: users.email");
          }
          if (users.some((candidate) => candidate.username === username)) {
            throw new Error("UNIQUE constraint failed: users.username");
          }
          const id = users.reduce((highest, candidate) => Math.max(highest, candidate.id), 0) + 1;
          users.push({
            id,
            username,
            email,
            password_hash: String(params[2]),
            password_salt: String(params[3]),
            avatar_key: null,
            created_at: new Date().toISOString(),
          });
          return { success: true, meta: { changes: 1, last_row_id: id } };
        }

        if (normalized.startsWith("insert into sessions")) {
          sessions.push({
            id: String(params[0]),
            user_id: Number(params[1]),
            created_at: new Date().toISOString(),
            expires_at: String(params[2]),
          });
          return { success: true, meta: { changes: 1, last_row_id: 0 } };
        }

        if (normalized.startsWith("delete from sessions")) {
          const sessionId = String(params[0]);
          const before = sessions.length;
          if (normalized.includes("expires_at <= datetime('now')")) {
            for (let index = sessions.length - 1; index >= 0; index -= 1) {
              if (sessions[index].id === sessionId && !isLive(sessions[index].expires_at)) sessions.splice(index, 1);
            }
          } else {
            for (let index = sessions.length - 1; index >= 0; index -= 1) {
              if (sessions[index].id === sessionId) sessions.splice(index, 1);
            }
          }
          return { success: true, meta: { changes: before - sessions.length, last_row_id: 0 } };
        }

        throw new Error(`Unsupported fake D1 run query: ${sql}`);
      },
    };
  }

  const prepare = (sql: string) => makeStatement(sql);
  return {
    DB: { prepare } as unknown as D1Database,
    users,
    sessions,
  } as unknown as AuthFakeEnv;
}
