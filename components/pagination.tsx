export type PaginationItem = number | "ellipsis";

export function paginationItems(page: number, pageCount: number): PaginationItem[] {
  if (!Number.isFinite(pageCount) || pageCount <= 1) return [];
  const total = Math.trunc(pageCount);
  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), total);
  const wanted = [1, total, current - 1, current, current + 1];
  const sorted = [...new Set(wanted)].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) items.push("ellipsis");
    items.push(p);
    previous = p;
  }
  return items;
}

type Props = { page: number; pageCount: number; href: (page: number) => string; label?: string };
const controlClass = "inline-flex min-h-[2.75rem] min-w-[2.75rem] items-center justify-center rounded-none px-hsp-xs text-small";

export function Pagination({ page, pageCount, href, label }: Props) {
  const items = paginationItems(page, pageCount);
  if (items.length === 0) return null;
  const total = Math.trunc(pageCount);
  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), total);
  return (
    <nav aria-label={label ?? "Pagination"} class="mt-vsp-md flex justify-center">
      <ul class="flex items-center gap-hsp-2xs">
        <li>{current > 1
          ? <a href={href(current - 1)} class={`${controlClass} text-ink-soft hover:text-brand`}>Previous</a>
          : <span aria-disabled="true" class={`${controlClass} text-ink-faint`}>Previous</span>}</li>
        {items.map((item, index) => item === "ellipsis"
          ? <li key={`ellipsis-${index}`} aria-hidden="true" class={`${controlClass} text-ink-faint`}>…</li>
          : <li key={item}><a href={href(item)} aria-current={item === current ? "page" : undefined}
              class={`${controlClass} ${item === current ? "bg-ink text-paper" : "text-ink-soft hover:text-brand"}`}>{item}</a></li>)}
        <li>{current < total
          ? <a href={href(current + 1)} class={`${controlClass} text-ink-soft hover:text-brand`}>Next</a>
          : <span aria-disabled="true" class={`${controlClass} text-ink-faint`}>Next</span>}</li>
      </ul>
    </nav>
  );
}
