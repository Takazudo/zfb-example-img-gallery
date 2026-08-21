#!/usr/bin/env node

/**
 * Foundation integration probe.
 *
 * The probe intentionally talks to a separately started local Wrangler Worker
 * over HTTP. Keep the Worker lifecycle outside this process so callers can
 * wrap `wrangler dev` in a bounded orchestration and always terminate it.
 * D1/R2 CLI calls use the same persistence directory as that Worker.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseUrl = (process.env.CONFIRM_BASE_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const persistTo = process.env.WRANGLER_PERSIST ?? ".wrangler/state";
const wranglerConfig = readFileSync(join(repoRoot, "wrangler.toml"), "utf8");

function configValue(name) {
  const match = wranglerConfig.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`wrangler.toml is missing top-level ${name}`);
  return match[1];
}

const databaseName = configValue("database_name");
const bucketName = configValue("bucket_name");
const fixturePath = join(repoRoot, "public", "og-fallback.jpg");
const fixtureBytes = readFileSync(fixturePath);
const notFoundHtml = readFileSync(join(repoRoot, "dist", "404.html"), "utf8");

const ownedKeys = new Set();
let fixtureUserId = null;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runWrangler(args) {
  try {
    return execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stdout = error?.stdout?.toString?.() ?? "";
    const stderr = error?.stderr?.toString?.() ?? "";
    throw new Error(
      `Wrangler command failed (${args.join(" ")}):\n${stdout}\n${stderr}`,
      { cause: error },
    );
  }
}

function d1(sql) {
  const output = runWrangler([
    "d1", "execute", databaseName,
    "--local", "--persist-to", persistTo, "--json", "--command", sql,
  ]);
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`D1 did not return JSON:\n${output}`, { cause: error });
  }
  const result = payload?.[0];
  assert(result?.success === true, `D1 query failed: ${sql}`);
  return result.results ?? [];
}

function d1Write(sql) {
  return d1(sql);
}

function r2Put(key, contentType = "image/jpeg") {
  runWrangler([
    "r2", "object", "put", `${bucketName}/${key}`,
    "--file", fixturePath, "--content-type", contentType,
    "--local", "--persist-to", persistTo,
  ]);
  ownedKeys.add(key);
}

function r2Delete(key) {
  try {
    runWrangler([
      "r2", "object", "delete", `${bucketName}/${key}`,
      "--local", "--persist-to", persistTo,
    ]);
  } catch {
    // Cleanup is best effort: the primary assertion failure remains useful.
  }
}

function r2Get(key, destination) {
  runWrangler([
    "r2", "object", "get", `${bucketName}/${key}`,
    "--file", destination, "--local", "--persist-to", persistTo,
  ]);
}

async function http(path, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
  } catch (error) {
    throw new Error(`HTTP request failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { response, bytes, text: new TextDecoder().decode(bytes) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cookieValue(setCookie) {
  const match = /^sid=([^;]*)/.exec(setCookie ?? "");
  return match?.[1] ?? null;
}

function assertSessionCookie(setCookie, expectedLength = 64) {
  assert(setCookie, "response did not include Set-Cookie");
  const sid = cookieValue(setCookie);
  assert(sid && new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(sid),
    `sid must be ${expectedLength} lowercase hex characters: ${setCookie}`);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=604800"]) {
    assert(setCookie.includes(attribute), `sid cookie is missing ${attribute}: ${setCookie}`);
  }
  return sid;
}

function assertHeader(response, name, expected) {
  assert(response.headers.get(name) === expected,
    `${name} expected ${expected}, got ${response.headers.get(name)}`);
}

function jpegSize(bytes) {
  let offset = 2;
  while (offset < bytes.length - 9) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (!Number.isFinite(segmentLength) || segmentLength < 2) break;
    offset += 2 + segmentLength;
  }
  throw new Error("JPEG did not contain a SOF marker");
}

function queryPhotoId(key) {
  const rows = d1(`SELECT id FROM photos WHERE r2_key = ${sqlString(key)};`);
  assert(rows.length === 1, `expected one fixture photo for ${key}`);
  return Number(rows[0].id);
}

function cleanupFixtureRows() {
  const users = d1("SELECT id FROM users WHERE email = 'confirm@example.com';");
  for (const row of users) {
    const userId = Number(row.id);
    d1Write([
      `DELETE FROM photo_tags WHERE photo_id IN (SELECT id FROM photos WHERE user_id = ${userId})`,
      `DELETE FROM photos WHERE user_id = ${userId}`,
      `DELETE FROM sessions WHERE user_id = ${userId}`,
      `DELETE FROM users WHERE id = ${userId}`,
    ].join("; "));
  }
}

function checkConfig() {
  assert(wranglerConfig.includes('compatibility_date = "2026-05-01"'),
    "wrangler.toml must stay within Wrangler 4.85.0's local runtime date");
  assert(wranglerConfig.includes('compatibility_flags = ["nodejs_compat"]'),
    "wrangler.toml must enable nodejs_compat");
  assert(wranglerConfig.includes('not_found_handling = "404-page"'),
    "Static Assets must use the committed 404 page");
  assert(wranglerConfig.includes('[images]\nbinding = "IMAGES"'),
    "wrangler.toml is missing the IMAGES binding");
  const assetsMatch = /^\[assets\]\s*$/m.exec(wranglerConfig);
  assert(assetsMatch, "wrangler.toml is missing [assets]");
  const assetsIndex = assetsMatch.index;
  for (const key of ["workers_dev = true", "preview_urls = true"]) {
    assert(wranglerConfig.indexOf(key) >= 0 && wranglerConfig.indexOf(key) < assetsIndex,
      `${key} must be above [assets]`);
  }
  for (const rule of [
    '"/"', '"/page/*"', '"/photos/*"', '"/authors"', '"/authors/*"',
    '"/tags"', '"/tags/*"', '"/img/*"', '"/og/*"', '"/robots.txt"',
    '"/sitemap.xml"', '"/register"', '"/login"', '"/logout"',
    '"/settings"', '"/upload"',
  ]) assert(wranglerConfig.includes(rule), `run_worker_first is missing ${rule}`);
  assert(!wranglerConfig.includes('"/og/v1/*"'),
    "run_worker_first must not contain redundant /og/v1/* under Wrangler 4.85.0");
  for (const section of ["[[d1_databases]]", "[[r2_buckets]]", "[[env.preview.d1_databases]]", "[[env.preview.r2_buckets]]"]) {
    assert(wranglerConfig.includes(section), `wrangler.toml is missing ${section}`);
  }
  console.log("[confirm] Wrangler config: date, bindings, Static Assets routes, and preview duplication verified");
}

async function checkSchema() {
  const objects = d1("SELECT type, name FROM sqlite_master ORDER BY type, name;");
  const tables = new Set(objects.filter((row) => row.type === "table").map((row) => row.name));
  const indexes = new Set(objects.filter((row) => row.type === "index").map((row) => row.name));
  for (const table of ["users", "sessions", "photos", "tags", "photo_tags"]) {
    assert(tables.has(table), `missing D1 table ${table}`);
  }
  for (const index of ["idx_photos_feed", "idx_photos_user", "idx_photo_tags_tag", "idx_sessions_user", "idx_sessions_expires"]) {
    assert(indexes.has(index), `missing D1 index ${index}`);
  }
  const photoColumns = d1("PRAGMA table_info(photos);");
  for (const column of ["width", "height"]) {
    const row = photoColumns.find((candidate) => candidate.name === column);
    assert(row?.notnull === 1, `photos.${column} must be NOT NULL`);
  }
  console.log("[confirm] D1 schema: tables, indexes, and photo dimensions verified");
}

async function checkAuth() {
  const register = await http("/register", {
    method: "POST",
    body: new URLSearchParams({
      email: "confirm@example.com",
      username: "ConfirmUser",
      password: "local-confirm-fixture-pw",
    }),
  });
  assert(register.response.status === 303, `register expected 303, got ${register.response.status}`);
  const registerSid = assertSessionCookie(register.response.headers.get("set-cookie"));

  const users = d1("SELECT id, username, email, password_hash, password_salt FROM users WHERE email = 'confirm@example.com';");
  assert(users.length === 1, "register should create exactly one fixture user");
  const user = users[0];
  fixtureUserId = Number(user.id);
  assert(user.username === "confirmuser", `username was not normalised: ${user.username}`);
  assert(user.email === "confirm@example.com", `email was not normalised: ${user.email}`);
  assert(user.password_hash && user.password_salt, "password credentials were not stored");
  assert(!JSON.stringify(user).includes("local-confirm-fixture-pw"), "plaintext password leaked into users row");

  const session = d1(`SELECT id, user_id FROM sessions WHERE id = ${sqlString(registerSid)};`);
  assert(session.length === 1 && Number(session[0].user_id) === fixtureUserId,
    "register session did not point to the new user");
  // A fixed-width cryptographic token can naturally contain a user-id digit;
  // opacity is established by its independent random hex shape and the fact
  // that only the server-side session row links it to this user.
  assert(registerSid !== String(fixtureUserId), "session id is the raw user id");

  const collision = await http("/register", {
    method: "POST",
    body: new URLSearchParams({
      email: " CONFIRM@Example.com ",
      username: "ConfirmUser",
      password: "local-confirm-fixture-pw",
    }),
  });
  assert(collision.response.status === 409, `case-variant registration expected 409, got ${collision.response.status}`);
  assert(d1("SELECT COUNT(*) AS n FROM users WHERE email = 'confirm@example.com';")[0].n === 1,
    "case-variant registration created a duplicate account");

  const login = await http("/login", {
    method: "POST",
    body: new URLSearchParams({
      email: " CONFIRM@Example.com ",
      password: "local-confirm-fixture-pw",
    }),
  });
  assert(login.response.status === 303, `login expected 303, got ${login.response.status}`);
  const loginSid = assertSessionCookie(login.response.headers.get("set-cookie"));
  assert(loginSid !== registerSid, "login did not issue a fresh session");

  const getLogout = await http("/logout", { headers: { cookie: `sid=${loginSid}` } });
  assert(getLogout.response.status === 405, `GET /logout expected 405, got ${getLogout.response.status}`);
  assert(d1(`SELECT COUNT(*) AS n FROM sessions WHERE id = ${sqlString(loginSid)};`)[0].n === 1,
    "GET /logout destroyed the session");

  const postLogout = await http("/logout", {
    method: "POST",
    headers: { cookie: `sid=${loginSid}` },
  });
  assert(postLogout.response.status === 303, `POST /logout expected 303, got ${postLogout.response.status}`);
  const cleared = postLogout.response.headers.get("set-cookie") ?? "";
  assert(/^sid=;/.test(cleared), `logout did not clear sid: ${cleared}`);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=0"]) {
    assert(cleared.includes(attribute), `cleared cookie is missing ${attribute}: ${cleared}`);
  }
  assert(d1(`SELECT COUNT(*) AS n FROM sessions WHERE id = ${sqlString(loginSid)};`)[0].n === 0,
    "POST /logout left the session row behind");
  console.log("[confirm] auth: register, collision normalisation, login, and POST-only logout verified");
}

async function checkImageRoute() {
  const key = `photos/123e4567-e89b-12d3-a456-426614174000.jpg`;
  r2Put(key, "image/png");
  const hit = await http(`/img/${key}`);
  assert(hit.response.status === 200, `image GET expected 200, got ${hit.response.status}`);
  assert(sha256(hit.bytes) === sha256(fixtureBytes), "image response bytes differ from the R2 object");
  assertHeader(hit.response, "content-type", "image/png");
  assertHeader(hit.response, "cache-control", "public, max-age=31536000, immutable");
  assertHeader(hit.response, "x-content-type-options", "nosniff");
  assert(hit.response.headers.get("etag"), "image response is missing ETag");

  const head = await http(`/img/${key}`, { method: "HEAD" });
  assert(head.response.status === 200, `image HEAD expected 200, got ${head.response.status}`);
  for (const name of ["content-type", "cache-control", "x-content-type-options", "etag", "content-length"]) {
    assertHeader(head.response, name, hit.response.headers.get(name));
  }
  assert(head.bytes.byteLength === 0, "image HEAD returned a response body");

  const missing = await http("/img/photos/223e4567-e89b-12d3-a456-426614174000.jpg");
  assert(missing.response.status === 404, `missing image expected 404, got ${missing.response.status}`);
  for (const malformed of ["/img/../secret", "/img/photos/%2e%2e%2fx"]) {
    const response = await http(malformed);
    assert(response.response.status !== 200, `malformed image key was served: ${malformed}`);
  }
  console.log("[confirm] R2 image proxy: bytes, metadata headers, HEAD, misses, and key rejection verified");
}

async function checkOgRoute() {
  assert(fixtureUserId !== null, "OG fixtures require the auth fixture user");
  const sourceKey = `photos/${"223e4567-e89b-12d3-a456-426614174000"}.jpg`;
  const missingSourceKey = "photos/missing-0000.jpg";
  r2Put(sourceKey, "image/jpeg");
  d1Write([
    `INSERT INTO photos (user_id, title, description, r2_key, content_type, width, height, created_at)
     VALUES (${fixtureUserId}, 'Confirm fixture', 'fixture row', ${sqlString(sourceKey)}, 'image/jpeg', 1200, 630, '2026-01-01T00:00:00.000Z')`,
    `INSERT INTO photos (user_id, title, description, r2_key, content_type, width, height, created_at)
     VALUES (${fixtureUserId}, 'Broken fixture', 'no blob', ${sqlString(missingSourceKey)}, 'image/jpeg', 1200, 630, '2026-01-01T00:00:00.000Z')`,
  ].join("; "));
  const existingId = queryPhotoId(sourceKey);
  const missingId = queryPhotoId(missingSourceKey);

  // Add a probe-only cache buster so a prior failed local run cannot leave a
  // cached Static Assets 404 in front of a newly inserted fixture row.
  const cacheBust = `confirm=${Date.now()}`;
  const generated = await http(`/og/v1/${existingId}.jpg?${cacheBust}`);
  assert(generated.response.status === 200, `OG generation expected 200, got ${generated.response.status}`);
  assertHeader(generated.response, "content-type", "image/jpeg");
  const dimensions = jpegSize(generated.bytes);
  assert(dimensions.width === 1200 && dimensions.height === 630,
    `generated OG dimensions were ${dimensions.width}x${dimensions.height}`);

  const generatedKey = `derived/og/v1/${existingId}.jpg`;
  ownedKeys.add(generatedKey);
  const derivedPath = join(repoRoot, ".tmp-confirm-og.jpg");
  try {
    r2Get(generatedKey, derivedPath);
    assert(existsSync(derivedPath), "generated OG object was not persisted to R2");
    const persisted = readFileSync(derivedPath);
    assert(sha256(persisted) === sha256(generated.bytes), "persisted OG bytes differ from the response");
  } finally {
    // Keep the probe's temporary artifact out of the repository.
    if (existsSync(derivedPath)) unlinkSync(derivedPath);
  }

  const cached = await http(`/og/v1/${existingId}.jpg?${cacheBust}`);
  assert(cached.response.status === 200, `OG cache hit expected 200, got ${cached.response.status}`);
  assert(sha256(cached.bytes) === sha256(generated.bytes), "OG cache-hit bytes changed");
  assert((cached.response.headers.get("cache-control") ?? "").includes("immutable"),
    "OG cache hit is not immutable");

  const fallback = await http(`/og/v1/${missingId}.jpg?${cacheBust}`);
  assert(fallback.response.status === 200, `missing-source OG expected fallback 200, got ${fallback.response.status}`);
  assert(sha256(fallback.bytes) === sha256(fixtureBytes), "OG fallback bytes differ from public/og-fallback.jpg");
  assertHeader(fallback.response, "cache-control", "public, max-age=60");

  const unknown = await http(`/og/v1/999999.jpg?${cacheBust}`);
  assert(unknown.response.status === 404, `unknown OG id expected 404, got ${unknown.response.status}`);
  console.log("[confirm] OG cards: generation, R2 persistence/cache hit, fallback, and unknown-id 404 verified");
}

async function checkNavigationAndSite() {
  const paths = [
    "/", "/authors", "/tags", "/register", "/login", "/logout", "/settings", "/upload",
    "/page/2", "/photos/1", "/tags/example", "/img/photos/x.jpg", "/og/v1/999999.jpg",
  ];
  for (const path of paths) {
    const plain = await http(path);
    const navigate = await http(path, {
      headers: {
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        accept: "text/html,application/xhtml+xml",
      },
    });
    assert(plain.response.status === navigate.response.status && plain.text === navigate.text,
      `navigation differential failed at ${path}: plain ${plain.response.status}, navigate ${navigate.response.status}`);
    if (["/", "/register", "/login"].includes(path)) {
      assert(navigate.text !== notFoundHtml, `${path} navigation returned dist/404.html`);
    }
    const executableScript = /<script\b(?![^>]*\btype=["']application\/ld\+json["'])[^>]*>/i;
    assert(!executableScript.test(navigate.text), `${path} response contains an executable script tag`);
  }

  const root = await http("/");
  assert(root.response.status === 200, `root expected 200, got ${root.response.status}`);
  assert((root.response.headers.get("content-type") ?? "").startsWith("text/html"), "root is not HTML");
  for (const marker of [
    'rel="canonical"', 'property="og:title"', 'property="og:type"', 'property="og:url"',
    'property="og:site_name"', 'name="twitter:card"', 'href="/assets/app.css"',
  ]) assert(root.text.includes(marker), `root is missing SEO/assets marker ${marker}`);
  const canonical = root.text.match(/rel="canonical" href="([^"]+)"/)?.[1] ?? "";
  const ogUrl = root.text.match(/property="og:url" content="([^"]+)"/)?.[1] ?? "";
  assert(/^https?:\/\//.test(canonical) && /^https?:\/\//.test(ogUrl), "canonical and og:url must be absolute");

  const css = await http("/assets/app.css");
  assert(css.response.status === 200, `stable CSS expected 200, got ${css.response.status}`);
  const robots = await http("/robots.txt");
  assert(robots.response.status === 200 && (robots.response.headers.get("content-type") ?? "").includes("text/plain"),
    "robots.txt did not reach its Worker route");
  const sitemap = await http("/sitemap.xml");
  assert(sitemap.response.status === 200 && (sitemap.response.headers.get("content-type") ?? "").includes("application/xml"),
    "sitemap.xml did not reach its Worker route");
  assert(sitemap.text.includes("https://"), "sitemap did not emit canonical absolute URLs");
  console.log("[confirm] navigation differential, script-free current pages, SEO root, CSS, robots, and sitemap verified");
}

async function main() {
  assert(existsSync(fixturePath), `fixture is missing: ${fixturePath}`);
  assert(existsSync(join(repoRoot, "dist", "404.html")), "build output dist/404.html is missing");
  const fixtureDimensions = jpegSize(fixtureBytes);
  assert(fixtureDimensions.width === 1200 && fixtureDimensions.height === 630,
    `public/og-fallback.jpg must be 1200x630, got ${fixtureDimensions.width}x${fixtureDimensions.height}`);
  checkConfig();
  cleanupFixtureRows();
  await checkSchema();
  await checkAuth();
  await checkImageRoute();
  await checkOgRoute();
  await checkNavigationAndSite();
}

try {
  await main();
  console.log("[confirm] foundation integration probe passed");
} catch (error) {
  console.error(`[confirm] ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const key of ownedKeys) r2Delete(key);
  try {
    // Re-query by the fixture's exact normalised email so a failure before
    // fixtureUserId is assigned still cannot leave a user or dependent rows.
    cleanupFixtureRows();
  } catch (error) {
    console.error(`[confirm] fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
