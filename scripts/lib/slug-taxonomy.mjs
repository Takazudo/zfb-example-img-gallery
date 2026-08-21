/**
 * The source site occasionally keeps a deleted image row in its content.  Keep
 * the list in one place so discovery, mirroring, and manifest validation cannot
 * drift apart.
 */
export const DEAD_SLUGS = [
  "zudo-stand-60x2-view5",
  "panels-gallery-zudo-blocks-142",
  "panels-gallery-zudo-blocks-101",
  "zb60-all-02",
  "zb60-open-high-view-b",
  "zudo-block-build",
];

/**
 * Canonical family names used by the seed data.  The table deliberately stays
 * plain data: it is useful to the scripts, and is easy to tune without making
 * the parser clever about product identity.
 */
export const FAMILIES = {
  "zudo-block-60x2": { displayName: "Zudo Block 60x2", materialHint: "3d printed" },
  "zudo-block-40x2": { displayName: "Zudo Block 40x2", materialHint: "3d printed" },
  "zudo-block-7u": { displayName: "Zudo Block 7u", materialHint: "3d printed" },
  "zudo-block-x2": { displayName: "Zudo Block x2", materialHint: "3d printed" },
  "zudo-block": { displayName: "Zudo Block", materialHint: "3d printed" },
  "zudo-stand-60x2": { displayName: "Zudo Stand 60x2", materialHint: "3d printed" },
  "zudo-stand-40x2": { displayName: "Zudo Stand 40x2", materialHint: "3d printed" },
  "zudo-stand-60": { displayName: "Zudo Stand 60", materialHint: "3d printed" },
  "zudo-stand-40": { displayName: "Zudo Stand 40", materialHint: "3d printed" },
  "zudo-stand": { displayName: "Zudo Stand", materialHint: "3d printed" },
  "zudo-rail": { displayName: "Zudo Rail", materialHint: "aluminium" },
  "zudo-bus": { displayName: "Zudo Bus", materialHint: "steel" },
  "zudo-3u-to-1u": { displayName: "Zudo 3u to 1u", materialHint: "3d printed" },
  "zudo-x2": { displayName: "Zudo x2", materialHint: "3d printed" },
  "zb40l": { displayName: "ZB40L", materialHint: "3d printed" },
  "zb40lite": { displayName: "ZB40 Lite", materialHint: "3d printed" },
  "zb40": { displayName: "ZB40", materialHint: "3d printed" },
  "zb60": { displayName: "ZB60", materialHint: "3d printed" },
  "blank-1u": { displayName: "Blank 1u", materialHint: "aluminium" },
  "blank-3u-m": { displayName: "Blank 3u Medium", materialHint: "aluminium" },
  "blank-3u-s": { displayName: "Blank 3u Small", materialHint: "aluminium" },
  "blank-crystal-flow": { displayName: "Blank Crystal Flow", materialHint: "acrylic" },
  "blank-grainscape": { displayName: "Blank Grainscape", materialHint: "acrylic" },
  "blank-grid-play": { displayName: "Blank Grid Play", materialHint: "acrylic" },
  "blank-rhythm-wave": { displayName: "Blank Rhythm Wave", materialHint: "acrylic" },
  "blank-streamlines": { displayName: "Blank Streamlines", materialHint: "acrylic" },
  "blank-set-l": { displayName: "Blank Set L", materialHint: "aluminium" },
  "panels-gallery-zudo-blocks": { displayName: "Zudo Block Panel", materialHint: "acrylic" },
  rail: { displayName: "Rail", materialHint: "aluminium" },
  "10box-stand": { displayName: "5BOX Go-Bako", materialHint: "3d printed" },
  "5box": { displayName: "5BOX Go-Bako", materialHint: "3d printed" },
};

const FAMILY_KEYS = Object.keys(FAMILIES).sort((a, b) => b.length - a.length);

function titleCaseToken(token) {
  return token.length === 0 ? token : token[0].toUpperCase() + token.slice(1);
}

/** Only the specified token-level transformation is used for slug titles. */
export function titleCaseTokens(tokens) {
  return tokens.flatMap((token) => token.split("-")).map(titleCaseToken);
}

function matchFamily(slug) {
  return FAMILY_KEYS.find((key) => slug === key || slug.startsWith(`${key}-`)) ?? null;
}

function viewHintFor(tokens) {
  const joined = tokens.join("-");
  if (/(?:^|-)view(?:-|\d|[a-z])/.test(joined)) return "detail view";
  if (/(?:^|-)front(?:-|$)/.test(joined)) return "front view";
  if (/(?:^|-)back(?:-|$)/.test(joined) || /(?:^|-)rear(?:-|$)/.test(joined)) return "rear view";
  if (/(?:^|-)side(?:-|$)/.test(joined)) return "side view";
  if (/(?:^|-)angle(?:-|$)/.test(joined) || /(?:^|-)angled(?:-|$)/.test(joined)) return "angled view";
  if (/(?:^|-)macro(?:-|$)/.test(joined) || /(?:^|-)close(?:-|$)/.test(joined)) return "macro view";
  if (/(?:^|-)overview(?:-|$)/.test(joined)) return "overview";
  if (/(?:^|-)in-case(?:-|$)/.test(joined)) return "in-case view";
  return null;
}

/**
 * Parse a source slug without consulting the network or filesystem.
 *
 * @param {string} slug
 * @returns {{slug:string,family:string|null,displayName:string,variantTokens:string[],materialHint:string|null,viewHint:string|null}}
 */
export function parseSlug(slug) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new TypeError("slug must be a non-empty string");
  }

  const family = matchFamily(slug);
  const tokens = slug.split("-");
  const familyTokenCount = family ? family.split("-").length : 0;
  const variantTokens = family ? tokens.slice(familyTokenCount) : tokens;
  const data = family ? FAMILIES[family] : null;

  return {
    slug,
    family,
    displayName: data?.displayName ?? titleCaseTokens(tokens).join(" ").trim(),
    variantTokens,
    materialHint: data?.materialHint ?? null,
    viewHint: viewHintFor(variantTokens),
  };
}

/**
 * Build an injective human title.  In particular, `view5` and `view-5` retain
 * different token boundaries in the result.
 */
export function titleFromSlug(slug) {
  const parsed = parseSlug(slug);
  return [parsed.displayName, ...titleCaseTokens(parsed.variantTokens)].join(" ").trim();
}

/**
 * Base tags grounded in identity alone.  The description script adds gated
 * visual facets and then applies its stricter normalisation/cap rules.
 */
export function tagsFromSlug(slug) {
  const parsed = parseSlug(slug);
  const tags = [];
  if (parsed.family) tags.push(parsed.family);
  if (parsed.materialHint) tags.push(parsed.materialHint);
  for (const token of parsed.variantTokens) {
    if (token && !tags.includes(token)) tags.push(token);
  }
  return tags;
}
