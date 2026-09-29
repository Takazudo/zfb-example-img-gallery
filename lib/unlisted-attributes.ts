import type { Child } from "@takazudo/zfb/zudo-react";
import { renderToString } from "@takazudo/zfb/zudo-react/server";

// zfb 3.0.0 throws ZR_ATTRIBUTE for these standard attributes (https://github.com/Takazudo/zudo-front-builder/issues/3359).
export const UNLISTED_ATTRIBUTES = [
  "property",
  "popover",
  "popovertarget",
  "popovertargetaction",
  "form",
  "fetchpriority",
] as const;

export type UnlistedAttribute = (typeof UNLISTED_ATTRIBUTES)[number];

const PLACEHOLDER_PREFIX = "data-unlisted-";
const RESTORED = new Set<string>(UNLISTED_ATTRIBUTES.map((name) => `${PLACEHOLDER_PREFIX}${name}`));

/** Placeholder spelling the renderer accepts; renderWithUnlistedAttributes() restores the real name. */
export function unlisted(name: UnlistedAttribute, value: string): Record<string, string> {
  return { [`${PLACEHOLDER_PREFIX}${name}`]: value };
}

/**
 * Render static markup (never an island) and rename the placeholder attributes.
 *
 * The renderer escapes `<`, `>` and `"` in text and attribute values, so every
 * `<…>` match is a real tag and every ` name="value"` pair inside it is a real
 * attribute: user content can never be renamed.
 */
export function renderWithUnlistedAttributes(node: Child): string {
  return renderToString(node).replace(/<[A-Za-z][^<>]*>/g, (tag) =>
    tag.replace(/ ([^\s="<>/]+)(="[^"]*")?/g, (attribute, name: string, value: string | undefined) =>
      RESTORED.has(name) ? ` ${name.slice(PLACEHOLDER_PREFIX.length)}${value ?? ""}` : attribute,
    ),
  );
}
