import { MAX_BULK_DELETE } from "./db/photo-purge";

export const DELETE_RETRY_MESSAGE = "We could not delete those photos. Please try again.";

type DeleteAction = {
  ids: number[];
  title: string | null;
  returnTo: string;
  invoker: HTMLElement | null;
};

export type PhotoActionsEnvironment = {
  document: Document;
  dialog: HTMLDialogElement;
  message: HTMLElement;
  error: HTMLElement;
  confirm: HTMLButtonElement;
  cancel: HTMLButtonElement;
  fetch: typeof fetch;
  invalidateSnapshots: () => void;
  refreshFeed: () => Promise<boolean>;
  navigate: (url: string) => void;
  currentUrl: () => string;
};

function positiveId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function selectedInputs(document: Document): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[data-photo-select="true"]')];
}

/** Use the live route for enhanced actions; appended page markup may carry a
 * different canonical fallback for ordinary, no-JavaScript form submission. */
function currentReturnPath(currentUrl: string, fallback: string): string {
  try {
    const current = new URL(currentUrl);
    return `${current.pathname}${current.search}${current.hash}`;
  } catch {
    return fallback;
  }
}

export class PhotoActionsController {
  readonly #env: PhotoActionsEnvironment;
  readonly #selected = new Set<number>();
  #pending: DeleteAction | null = null;
  #inFlight: Promise<void> | null = null;
  #destroyed = false;

  static mount(environment: PhotoActionsEnvironment): PhotoActionsController {
    return new PhotoActionsController(environment);
  }

  constructor(environment: PhotoActionsEnvironment) {
    this.#env = environment;
    environment.document.addEventListener("submit", this.#onSubmit, true);
    environment.document.addEventListener("change", this.#onChange, true);
    environment.document.addEventListener("click", this.#onClick, true);
    environment.dialog.addEventListener("cancel", this.#onCancel);
    environment.dialog.addEventListener("close", this.#onClose);
    environment.confirm.addEventListener("click", this.#onConfirm);
    environment.cancel.addEventListener("click", this.#onCancelClick);
    this.reconcile();
  }

  get selectedCount(): number { return this.#selected.size; }
  get pending(): Promise<void> | null { return this.#inFlight; }

  reconcile(): void {
    const inputs = selectedInputs(this.#env.document);
    const loaded = new Map<number, HTMLInputElement>();
    for (const input of inputs) {
      const id = positiveId(input.value);
      if (id !== null) loaded.set(id, input);
    }
    for (const id of this.#selected) if (!loaded.has(id)) this.#selected.delete(id);
    for (const [id, input] of loaded) input.checked = this.#selected.has(id);
    this.#updateToolbar();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#env.document.removeEventListener("submit", this.#onSubmit, true);
    this.#env.document.removeEventListener("change", this.#onChange, true);
    this.#env.document.removeEventListener("click", this.#onClick, true);
    this.#env.dialog.removeEventListener("cancel", this.#onCancel);
    this.#env.dialog.removeEventListener("close", this.#onClose);
    this.#env.confirm.removeEventListener("click", this.#onConfirm);
    this.#env.cancel.removeEventListener("click", this.#onCancelClick);
  }

  readonly #onChange = (event: Event): void => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches?.('[data-photo-select="true"]')) return;
    const id = positiveId(input.value);
    if (id === null) { input.checked = false; return; }
    if (input.checked) {
      if (this.#selected.size >= MAX_BULK_DELETE && !this.#selected.has(id)) input.checked = false;
      else this.#selected.add(id);
    } else this.#selected.delete(id);
    this.#updateToolbar();
  };

  readonly #onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const all = target?.closest?.("[data-photo-select-all]");
    const clear = target?.closest?.("[data-photo-clear]");
    if (!all && !clear) return;
    event.preventDefault();
    if (clear) this.#selected.clear();
    if (all) {
      for (const input of selectedInputs(this.#env.document)) {
        const id = positiveId(input.value);
        if (id === null || this.#selected.has(id)) continue;
        if (this.#selected.size === MAX_BULK_DELETE) break;
        this.#selected.add(id);
      }
    }
    this.reconcile();
  };

  readonly #onSubmit = (event: SubmitEvent): void => {
    const form = event.target as HTMLFormElement | null;
    if (!form?.matches?.("[data-photo-delete-form], [data-photo-bulk-delete-form]")) return;
    const bulk = form.matches("[data-photo-bulk-delete-form]");
    const ids = bulk
      ? [...this.#selected]
      : [positiveId(form.querySelector<HTMLInputElement>('input[name="photo_id"]')?.value)].filter((id): id is number => id !== null);
    if (ids.length === 0 || ids.length > MAX_BULK_DELETE) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this.#inFlight || this.#env.dialog.open) return;
    const submitter = event.submitter as HTMLElement | null;
    const button = submitter ?? form.querySelector<HTMLElement>('button[type="submit"]');
    const title = bulk ? null : button?.dataset.photoTitle ?? null;
    const formReturnTo = form.querySelector<HTMLInputElement>('input[name="return_to"]')?.value || "/my-photos";
    const returnTo = currentReturnPath(this.#env.currentUrl(), formReturnTo);
    this.#pending = { ids, title, returnTo, invoker: button };
    this.#env.message.textContent = ids.length === 1
      ? `Delete “${title ?? "this photo"}” permanently? This cannot be undone.`
      : `Delete ${ids.length} photos permanently? This cannot be undone.`;
    this.#env.error.textContent = "";
    this.#env.error.hidden = true;
    this.#env.dialog.showModal();
    this.#env.cancel.focus();
  };

  readonly #onCancel = (event: Event): void => {
    event.preventDefault();
    if (this.#inFlight) return;
    this.#env.dialog.close();
  };

  readonly #onCancelClick = (): void => {
    if (!this.#inFlight) this.#env.dialog.close();
  };

  readonly #onClose = (): void => {
    // Native dialog close events are queued. If the user reopens the same
    // dialog before an earlier close event runs, that stale event must not
    // clear the newly prepared deletion action.
    if (this.#env.dialog.open) return;
    const invoker = this.#pending?.invoker;
    this.#pending = null;
    if (invoker?.isConnected) invoker.focus();
  };

  readonly #onConfirm = (): void => {
    if (!this.#pending || this.#inFlight) return;
    const action = this.#pending;
    this.#setBusy(true);
    const task = this.#delete(action).finally(() => {
      if (this.#inFlight === task) this.#inFlight = null;
      this.#setBusy(false);
    });
    this.#inFlight = task;
  };

  async #delete(action: DeleteAction): Promise<void> {
    let failureMessage = DELETE_RETRY_MESSAGE;
    try {
      const response = await this.#env.fetch("/my-photos", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ photo_ids: action.ids, confirmed: true, return_to: action.returnTo }),
      });
      const body = await response.json() as { deletedIds?: unknown; redirectTo?: unknown; error?: unknown };
      if (!response.ok || !Array.isArray(body.deletedIds) || typeof body.redirectTo !== "string") {
        if (typeof body.error === "string" && body.error.trim()) failureMessage = body.error;
        throw new Error("Delete request failed");
      }
      this.#env.invalidateSnapshots();
      for (const id of action.ids) this.#selected.delete(id);
      const current = new URL(this.#env.currentUrl(), "https://photo-actions.invalid");
      const destination = new URL(body.redirectTo, current);
      this.#env.dialog.close();
      if (`${destination.pathname}${destination.search}` !== `${current.pathname}${current.search}`) {
        this.#env.navigate(body.redirectTo);
        return;
      }
      let refreshed = false;
      try {
        refreshed = await this.#env.refreshFeed();
      } catch {
        // The server mutation succeeded; fall back to a normal navigation.
      }
      if (!refreshed) this.#env.navigate(body.redirectTo);
      else this.reconcile();
    } catch {
      this.#env.error.textContent = failureMessage;
      this.#env.error.hidden = false;
      this.#env.confirm.focus();
    }
  }

  #setBusy(busy: boolean): void {
    this.#env.confirm.disabled = busy;
    this.#env.cancel.disabled = busy;
    this.#env.dialog.toggleAttribute("aria-busy", busy);
  }

  #updateToolbar(): void {
    const count = this.#env.document.querySelector<HTMLElement>("[data-photo-selected-count]");
    if (count) count.textContent = `${this.#selected.size} ${this.#selected.size === 1 ? "photo" : "photos"} selected`;
    const disabled = this.#selected.size === 0;
    this.#env.document.querySelectorAll<HTMLButtonElement>("[data-photo-bulk-delete], [data-photo-clear]")
      .forEach((button) => button.disabled = disabled);
  }
}
