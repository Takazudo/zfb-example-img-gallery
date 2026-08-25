import { describe, expect, it, vi } from "vitest";
import { DELETE_RETRY_MESSAGE, PhotoActionsController } from "../../lib/photo-actions-controller";

type Listener = (event: any) => void;

class FakeElement {
  dataset: Record<string, string> = {};
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  isConnected = true;
  textContent = "";
  focused = 0;
  readonly attributes = new Set<string>();
  readonly listeners = new Map<string, Listener>();
  readonly queries = new Map<string, FakeElement | null>();
  kind = "element";
  matches(selector: string): boolean {
    if (selector === '[data-photo-select="true"]') return this.dataset.photoSelect === "true";
    if (selector === "[data-photo-delete-form], [data-photo-bulk-delete-form]") return this.kind === "single" || this.kind === "bulk";
    if (selector === "[data-photo-bulk-delete-form]") return this.kind === "bulk";
    return false;
  }
  closest(selector: string): FakeElement | null {
    if (selector === "[data-photo-select-all]" && this.dataset.photoSelectAll !== undefined) return this;
    if (selector === "[data-photo-clear]" && this.dataset.photoClear !== undefined) return this;
    return null;
  }
  querySelector<T>(selector: string): T | null { return (this.queries.get(selector) ?? null) as T | null; }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  toggleAttribute(name: string, force: boolean): void { if (force) this.attributes.add(name); else this.attributes.delete(name); }
  focus(): void { this.focused += 1; }
  showModal(): void { this.open = true; }
  close(): void { if (!this.open) return; this.open = false; this.listeners.get("close")?.({}); }
}

function harness(
  inputCount = 3,
  response?: Response | Promise<Response>,
  currentUrl = "https://example.test/my-photos",
) {
  const inputs = Array.from({ length: inputCount }, (_, index) => {
    const input = new FakeElement();
    input.dataset.photoSelect = "true";
    input.value = String(index + 1);
    return input;
  });
  const count = new FakeElement();
  const bulkDelete = new FakeElement();
  const clear = new FakeElement(); clear.dataset.photoClear = "true";
  const all = new FakeElement(); all.dataset.photoSelectAll = "true";
  const documentListeners = new Map<string, { listener: Listener; capture: boolean }>();
  const document = {
    addEventListener(type: string, listener: Listener, capture?: boolean) { documentListeners.set(type, { listener, capture: capture === true }); },
    removeEventListener: vi.fn(),
    querySelectorAll(selector: string) {
      if (selector === '[data-photo-select="true"]') return inputs;
      if (selector === "[data-photo-bulk-delete], [data-photo-clear]") return [bulkDelete, clear];
      return [];
    },
    querySelector(selector: string) { return selector === "[data-photo-selected-count]" ? count : null; },
  } as unknown as Document;
  const dialog = new FakeElement();
  const message = new FakeElement();
  const error = new FakeElement();
  const confirm = new FakeElement();
  const cancel = new FakeElement();
  const invalidateSnapshots = vi.fn();
  const refreshFeed = vi.fn(async () => true);
  const navigate = vi.fn();
  const fetchMock = vi.fn(async () => response ?? new Response(JSON.stringify({ deletedIds: [1], redirectTo: "/my-photos" }), { status: 200 }));
  const controller = new PhotoActionsController({
    document,
    dialog: dialog as unknown as HTMLDialogElement,
    message: message as unknown as HTMLElement,
    error: error as unknown as HTMLElement,
    confirm: confirm as unknown as HTMLButtonElement,
    cancel: cancel as unknown as HTMLButtonElement,
    fetch: fetchMock as typeof fetch,
    invalidateSnapshots,
    refreshFeed,
    navigate,
    currentUrl: () => currentUrl,
  });
  const dispatch = (type: string, target: FakeElement, extra: Record<string, unknown> = {}) => {
    const event = { target, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra };
    documentListeners.get(type)!.listener(event);
    return event;
  };
  const singleForm = (id = 1, title = "Photo 1", returnTo = "/my-photos") => {
    const form = new FakeElement(); form.kind = "single";
    const idInput = new FakeElement(); idInput.value = String(id);
    const returnInput = new FakeElement(); returnInput.value = returnTo;
    const button = new FakeElement(); button.dataset.photoTitle = title;
    form.queries.set('input[name="photo_id"]', idInput);
    form.queries.set('input[name="return_to"]', returnInput);
    form.queries.set('button[type="submit"]', button);
    return { form, button };
  };
  const bulkForm = () => {
    const form = new FakeElement(); form.kind = "bulk";
    const returnInput = new FakeElement(); returnInput.value = "/my-photos";
    const button = new FakeElement();
    form.queries.set('input[name="return_to"]', returnInput);
    form.queries.set('button[type="submit"]', button);
    return { form, button };
  };
  return { controller, inputs, count, bulkDelete, clear, all, dialog, message, error, confirm, cancel, fetchMock, invalidateSnapshots, refreshFeed, navigate, documentListeners, dispatch, singleForm, bulkForm };
}

describe("photo actions controller", () => {
  it("delegates selection for initial/appended cards and enforces the exact 100/101 boundary", () => {
    const h = harness(101);
    expect(h.documentListeners.get("submit")?.capture).toBe(true);
    h.dispatch("click", h.all);
    expect(h.controller.selectedCount).toBe(100);
    expect(h.inputs.filter((input) => input.checked)).toHaveLength(100);
    expect(h.inputs[100]!.checked).toBe(false);
    h.dispatch("click", h.clear);
    expect(h.controller.selectedCount).toBe(0);
    expect(h.bulkDelete.disabled).toBe(true);
    const appended = new FakeElement(); appended.dataset.photoSelect = "true"; appended.value = "102"; appended.checked = true;
    h.inputs.push(appended);
    h.dispatch("change", appended);
    expect(h.controller.selectedCount).toBe(1);
    expect(h.count.textContent).toBe("1 photo selected");
  });

  it("cancels by button or Escape without mutation and restores invoking focus", () => {
    const h = harness();
    const { form, button } = h.singleForm(1, "A quiet lake");
    const submit = h.dispatch("submit", form, { submitter: button });
    expect(submit.preventDefault).toHaveBeenCalledOnce();
    expect(submit.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(h.dialog.open).toBe(true);
    expect(h.message.textContent).toContain("A quiet lake");
    h.cancel.listeners.get("click")?.({});
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(button.focused).toBe(1);

    h.dispatch("submit", form, { submitter: button });
    const escape = { preventDefault: vi.fn() };
    h.dialog.listeners.get("cancel")?.(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("submits exactly once after confirmation, invalidates snapshots, refreshes, and reconciles selection", async () => {
    let resolve!: (response: Response) => void;
    const response = new Promise<Response>((done) => { resolve = done; });
    const h = harness(2, response);
    h.inputs[0]!.checked = true; h.dispatch("change", h.inputs[0]!);
    const { form, button } = h.bulkForm();
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    h.confirm.listeners.get("click")?.({});
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.confirm.disabled).toBe(true);
    resolve(new Response(JSON.stringify({ deletedIds: [1], redirectTo: "/my-photos" }), { status: 200 }));
    await h.controller.pending;
    expect(h.invalidateSnapshots).toHaveBeenCalledOnce();
    expect(h.refreshFeed).toHaveBeenCalledOnce();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.controller.selectedCount).toBe(0);
  });

  it("keeps a reopened action when an earlier queued close event arrives", async () => {
    const h = harness();
    const first = h.singleForm(1, "First photo");
    const second = h.singleForm(2, "Second photo");

    h.dispatch("submit", first.form, { submitter: first.button });
    h.dialog.open = false;
    h.dispatch("submit", second.form, { submitter: second.button });

    // Browsers queue the first dialog's close event. It may run after the
    // second showModal() call when interactions happen in quick succession.
    h.dialog.listeners.get("close")?.({});
    expect(h.dialog.open).toBe(true);

    h.confirm.listeners.get("click")?.({});
    expect(h.fetchMock).toHaveBeenCalledOnce();
    await h.controller.pending;
  });

  it("keeps the dialog and selected state on failure so confirmation can be retried", async () => {
    const h = harness(1, new Response(JSON.stringify({ error: "Server unavailable" }), { status: 503 }));
    h.inputs[0]!.checked = true; h.dispatch("change", h.inputs[0]!);
    const { form, button } = h.bulkForm();
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    await h.controller.pending;
    expect(h.dialog.open).toBe(true);
    expect(h.controller.selectedCount).toBe(1);
    expect(h.error.hidden).toBe(false);
    expect(h.error.textContent).toBe("Server unavailable");
    expect(DELETE_RETRY_MESSAGE).toContain("try again");
  });

  it("announces a stable retry message for network and malformed-response failures", async () => {
    let reject!: (error: Error) => void;
    const response = new Promise<Response>((_resolve, fail) => { reject = fail; });
    const h = harness(1, response);
    const { form, button } = h.singleForm();
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    reject(new Error("internal transport detail"));
    await h.controller.pending;
    expect(h.error.textContent).toBe(DELETE_RETRY_MESSAGE);
    expect(h.dialog.open).toBe(true);
  });

  it("uses the safe server destination when deleting the current detail", async () => {
    const h = harness(1, new Response(JSON.stringify({ deletedIds: [1], redirectTo: "/favorites" }), { status: 200 }));
    const { form, button } = h.singleForm();
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    await h.controller.pending;
    expect(h.navigate).toHaveBeenCalledWith("/favorites");
    expect(h.refreshFeed).not.toHaveBeenCalled();
  });

  it("uses the live route when an appended card carries its source page fallback", async () => {
    const h = harness(
      1,
      new Response(JSON.stringify({ deletedIds: [1], redirectTo: "/my-photos?expanded=1" }), { status: 200 }),
      "https://example.test/my-photos?expanded=1",
    );
    const { form, button } = h.singleForm(1, "Appended photo", "/my-photos/page/2");
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    await h.controller.pending;

    const calls = h.fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    const request = calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toMatchObject({
      photo_ids: [1],
      return_to: "/my-photos?expanded=1",
    });
    expect(h.refreshFeed).toHaveBeenCalledOnce();
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("falls back to navigation if post-delete feed reconciliation throws", async () => {
    const h = harness();
    h.refreshFeed.mockRejectedValueOnce(new Error("refresh failed"));
    const { form, button } = h.singleForm();
    h.dispatch("submit", form, { submitter: button });
    h.confirm.listeners.get("click")?.({});
    await h.controller.pending;
    expect(h.navigate).toHaveBeenCalledWith("/my-photos");
    expect(h.error.hidden).toBe(true);
  });
});
