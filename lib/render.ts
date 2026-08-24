import type { VNode } from "preact";
import { render } from "preact-render-to-string";

/** Render a Preact tree to a full HTML-document `Response`. */
export function htmlResponse(node: VNode, status = 200): Response {
  const body = `<!DOCTYPE html>${render(node)}`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * A 303 "See Other" redirect. 303 (not 302) makes the browser issue a GET for
 * the target — the correct POST-then-redirect pattern, so a refresh does not
 * re-submit the form. Every mutation remains a plain `<form method="post">`
 * fallback. When the zfb router is active it soft-submits eligible forms and
 * follows this redirect without replaying the mutation.
 */
export function redirect(location: string, extraHeaders?: Record<string, string>): Response {
  return new Response(null, { status: 303, headers: { location, ...extraHeaders } });
}
