import type { ComponentChildren } from "preact";

type Props = {
  variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md";
  type?: "submit" | "button"; href?: string; disabled?: boolean; class?: string;
  children: ComponentChildren;
};
const variants = {
  primary: "bg-brand text-on-brand hover:bg-brand-strong",
  secondary: "border border-line bg-surface text-ink hover:border-brand hover:text-brand",
  ghost: "text-ink-soft hover:text-brand",
  danger: "bg-danger text-on-danger hover:bg-danger hover:brightness-90",
};

export function Button({ variant = "primary", size = "md", type = "submit", href, disabled,
  class: className = "", children }: Props) {
  const sizeClass = size === "sm" ? "min-h-[2.25rem] px-hsp-sm text-micro" : "min-h-[2.75rem] px-hsp-md text-small";
  const classes = `inline-flex items-center justify-center gap-hsp-2xs rounded-md font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${sizeClass} ${variants[variant]} ${className}`;
  return href ? <a href={href} class={classes}>{children}</a>
    : <button type={type} disabled={disabled} class={classes}>{children}</button>;
}
