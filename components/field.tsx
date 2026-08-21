type Props = {
  id: string; name: string; label: string; as?: "input" | "textarea";
  type?: "text" | "email" | "password" | "file"; value?: string; required?: boolean;
  hint?: string; error?: string; placeholder?: string; autoComplete?: string;
  accept?: string; rows?: number; maxLength?: number;
};

export function Field({ id, name, label, as = "input", type = "text", value, required, hint, error,
  placeholder, autoComplete, accept, rows, maxLength }: Props) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const common = {
    id, name, required, placeholder, autoComplete, maxLength,
    class: `w-full rounded-md border bg-surface px-hsp-sm py-vsp-xs text-body ${error ? "border-danger" : "border-line"}`,
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby": describedBy,
  };
  return (
    <div class="flex flex-col gap-vsp-2xs">
      <label for={id} class="text-small font-semibold">{label}{required ? <span class="text-danger" aria-hidden="true"> *</span> : null}</label>
      {as === "textarea"
        ? <textarea {...common} rows={rows ?? 5}>{value ?? ""}</textarea>
        : <input {...common} type={type} value={type === "file" ? undefined : value} accept={accept} />}
      {hint ? <p id={`${id}-hint`} class="text-micro text-ink-soft">{hint}</p> : null}
      {error ? <p id={`${id}-error`} class="text-small text-danger">{error}</p> : null}
    </div>
  );
}
