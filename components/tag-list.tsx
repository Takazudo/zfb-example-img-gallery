export type TagChip = { name: string; count?: number };
type Props = { tags: TagChip[]; size?: "sm" | "md" };

export function TagList({ tags, size = "sm" }: Props) {
  if (tags.length === 0) return null;
  const sizeClass = size === "md" ? "px-hsp-sm py-vsp-2xs text-small" : "px-hsp-xs py-vsp-2xs text-micro";
  return <ul class="flex flex-wrap gap-hsp-2xs">{tags.map((tag) => (
    <li key={tag.name}><a href={`/tags/${encodeURIComponent(tag.name)}`}
      class={`inline-flex items-center gap-hsp-2xs rounded-pill border border-line bg-surface text-ink-soft transition-colors hover:border-brand hover:text-brand ${sizeClass}`}>
      #{tag.name}{tag.count !== undefined ? <span class="text-ink-faint tabular-nums">{tag.count}</span> : null}
    </a></li>
  ))}</ul>;
}
