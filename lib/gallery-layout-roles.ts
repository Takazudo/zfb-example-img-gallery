export type SpotlightRole = {
  role: "feature" | "standard";
  columnStart: 1 | null;
  columnSpan: 1 | 2;
  rowSpan: 1 | 2;
};

export type EditorialRole = {
  role: "feature" | "wide" | "tall" | "standard";
  columnStart: 1 | 2 | 3 | 4;
  columnSpan: 1 | 2;
  rowSpan: 1 | 2;
};

export type JustifiedRole = {
  columnStart: 1 | 4 | 5 | 6 | 8 | 9 | 10;
  columnSpan: 3 | 4 | 5 | 6 | 7;
};

export type GalleryLayoutRoles = {
  spotlight: SpotlightRole;
  editorial: EditorialRole;
  justified: JustifiedRole;
  intrinsicAspectRatio: number;
};

const SPOTLIGHT_FEATURE_SLOTS = [0, 4, 8, 12] as const;

const EDITORIAL_ROLES: readonly EditorialRole[] = [
  { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 },
  { role: "wide", columnStart: 3, columnSpan: 2, rowSpan: 1 },
  { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
  { role: "tall", columnStart: 1, columnSpan: 1, rowSpan: 2 },
  { role: "standard", columnStart: 2, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 2, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 3, columnSpan: 1, rowSpan: 1 },
  { role: "standard", columnStart: 4, columnSpan: 1, rowSpan: 1 },
] as const;

const JUSTIFIED_ROLES: readonly JustifiedRole[] = [
  { columnStart: 1, columnSpan: 5 },
  { columnStart: 6, columnSpan: 3 },
  { columnStart: 9, columnSpan: 4 },
  { columnStart: 1, columnSpan: 3 },
  { columnStart: 4, columnSpan: 6 },
  { columnStart: 10, columnSpan: 3 },
  { columnStart: 1, columnSpan: 4 },
  { columnStart: 5, columnSpan: 4 },
  { columnStart: 9, columnSpan: 4 },
  { columnStart: 1, columnSpan: 7 },
  { columnStart: 8, columnSpan: 5 },
] as const;

function safeAbsoluteIndex(index: number): number {
  return Number.isSafeInteger(index) && index >= 0 ? index : 0;
}

export function getSpotlightRole(absoluteIndex: number): SpotlightRole {
  const index = safeAbsoluteIndex(absoluteIndex);
  const module = Math.floor(index / 17);
  const slot = index % 17;
  const feature = slot === SPOTLIGHT_FEATURE_SLOTS[module % SPOTLIGHT_FEATURE_SLOTS.length];
  return feature
    ? { role: "feature", columnStart: 1, columnSpan: 2, rowSpan: 2 }
    : { role: "standard", columnStart: null, columnSpan: 1, rowSpan: 1 };
}

export function getEditorialRole(absoluteIndex: number): EditorialRole {
  return EDITORIAL_ROLES[safeAbsoluteIndex(absoluteIndex) % EDITORIAL_ROLES.length]!;
}

export function getJustifiedRole(absoluteIndex: number): JustifiedRole {
  return JUSTIFIED_ROLES[safeAbsoluteIndex(absoluteIndex) % JUSTIFIED_ROLES.length]!;
}

/** A compact CSS-safe number; invalid source geometry reserves a square. */
export function getSafeIntrinsicAspectRatio(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  const ratio = width / height;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  const compactRatio = Number(ratio.toPrecision(6));
  return Number.isFinite(compactRatio) && compactRatio > 0 ? compactRatio : 1;
}

export function getGalleryLayoutRoles(
  absoluteIndex: number,
  width: number,
  height: number,
): GalleryLayoutRoles {
  return {
    spotlight: getSpotlightRole(absoluteIndex),
    editorial: getEditorialRole(absoluteIndex),
    justified: getJustifiedRole(absoluteIndex),
    intrinsicAspectRatio: getSafeIntrinsicAspectRatio(width, height),
  };
}

export function encodeSpotlightRole(role: SpotlightRole): string {
  return role.role === "feature" ? "f" : "s";
}

export function encodeEditorialRole(role: EditorialRole): string {
  const roleCode = role.role === "feature" ? "f" : role.role === "wide" ? "w" : role.role === "tall" ? "t" : "s";
  return `${roleCode}-${role.columnStart}-${role.columnSpan}-${role.rowSpan}`;
}

export function encodeJustifiedRole(role: JustifiedRole): string {
  return `${role.columnStart}-${role.columnSpan}`;
}

/** Compact class metadata: Spotlight bit plus shared 11-card cadence. */
export function encodeGalleryLayoutClass(absoluteIndex: number): string {
  const index = safeAbsoluteIndex(absoluteIndex);
  const spotlight = getSpotlightRole(index).role === "feature" ? "f" : "s";
  return `g${spotlight}${(index % 11).toString(36)}`;
}
