#!/usr/bin/env node
import { readFileSync } from "node:fs";

const wranglerToml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
// The route is deliberately commented until Cloudflare resources are provisioned;
// reading either form keeps the default aligned with the committed hostname.
const configuredHostname = wranglerToml.match(/^\s*#?\s*pattern\s*=\s*"([^"]+)"/m)?.[1]
  ?? "zfb-example-img-gallery.takazudomodular.com";
const target = process.env.SMOKE_URL ?? `https://${configuredHostname}/`;
const requireLive = process.env.SMOKE_REQUIRE_LIVE === "1";

const DNS_SKIP_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_SKIP_CODES = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ECONNRESET",
]);
const SKIP_CODES = new Set([...DNS_SKIP_CODES, ...TLS_SKIP_CODES]);
const RETRY_DELAYS_MS = [5_000, 15_000];

class RetryableSmokeError extends Error {}

function errorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  function visit(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
    seen.add(value);
    if ("code" in value && typeof value.code === "string") codes.add(value.code);
    if ("cause" in value) visit(value.cause);
    if ("errors" in value && Array.isArray(value.errors)) {
      for (const nested of value.errors) visit(nested);
    }
  }
  visit(error);
  return [...codes];
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function shouldSkipNetworkError(error) {
  if (requireLive) return false;
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((code) => SKIP_CODES.has(code));
}

function skip(reason) {
  console.log(`::notice::Production smoke skipped: ${reason}`);
}

function fail(reason) {
  console.error(`::error::Production smoke failed: ${reason}`);
  process.exitCode = 1;
}

async function checkPage() {
  const response = await fetch(target, { redirect: "follow" });
  if (response.status === 530 && !requireLive) {
    return { skip: "Cloudflare returned HTTP 530 (hostname is not attached yet)." };
  }
  if (response.status >= 500 || response.status === 429) {
    throw new RetryableSmokeError(`retryable HTTP status ${response.status}`);
  }
  if (response.status !== 200) throw new Error(`expected HTTP 200, got ${response.status}`);

  const contentType = response.headers.get("content-type") ?? "";
  if (!/text\/html/i.test(contentType)) throw new Error(`expected text/html, got ${contentType || "no content type"}`);

  const html = await response.text();
  if (!html.includes("Stillframe")) throw new Error("gallery chrome marker Stillframe is missing");

  const titles = html.match(/<h3\b[^>]*>[\s\S]*?<\/h3>/gi) ?? [];
  if (titles.length < 3) throw new Error(`expected at least three server-rendered photo titles, found ${titles.length}`);

  const photoLinks = html.match(/href=["']\/photos\/[1-9]\d*["']/g) ?? [];
  if (photoLinks.length < 1) throw new Error("no /photos/<id> link was rendered by the gallery grid");

  return { pass: true, titleCount: titles.length, photoLinkCount: photoLinks.length };
}

async function main() {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt += 1) {
    try {
      const result = await checkPage();
      if (result.skip) {
        skip(result.skip);
        return;
      }
      console.log(`::notice::Production smoke passed: ${target} (${result.titleCount} photo titles, ${result.photoLinkCount} photo links)`);
      return;
    } catch (error) {
      if (shouldSkipNetworkError(error)) {
        skip(`domain is not live yet (${errorCodes(error).join(", ")})`);
        return;
      }
      if (error instanceof RetryableSmokeError && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      fail(`${formatError(error)}${errorCodes(error).length ? ` [${errorCodes(error).join(", ")}]` : ""}`);
      return;
    }
  }
}

main().catch((error) => fail(formatError(error)));
