import type { ComponentChildren } from "preact";
import { Button } from "./button";

type Props = { title: string; children?: ComponentChildren; action?: { href: string; label: string } };

export function EmptyState({ title, children, action }: Props) {
  return (
    <div class="flex flex-col items-center gap-vsp-xs rounded-lg border border-dashed border-line bg-surface px-hsp-lg py-vsp-xl text-center">
      <p class="text-heading font-semibold">{title}</p>
      {children ? <div class="text-small text-ink-soft">{children}</div> : null}
      {action ? <Button href={action.href} variant="secondary">{action.label}</Button> : null}
    </div>
  );
}
