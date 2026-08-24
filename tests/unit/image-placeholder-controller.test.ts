import { afterEach, describe, expect, it } from "vitest";
import { ImagePlaceholderController } from "../../lib/image-placeholder-controller";

class FakeWrapper {
  readonly attributes = new Set<string>();
  setAttribute(name: string): void { this.attributes.add(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  contains(): boolean { return true; }
}

class FakeImage {
  nodeType = 1;
  complete = false;
  naturalWidth = 0;
  readonly wrapper = new FakeWrapper();
  querySelectorAll(): FakeImage[] { return []; }
  matches(): boolean { return true; }
  closest(): FakeWrapper { return this.wrapper; }
}

class FakeRoot {
  nodeType = 1;
  constructor(readonly images: FakeImage[]) {}
  matches(): boolean { return false; }
  querySelectorAll(): FakeImage[] { return this.images; }
}

type Listener = (event: Event) => void;

class FakeDocument extends FakeRoot {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly calls: string[] = [];
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    this.calls.push(`listen:${type}:${String(options)}`);
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as Listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.get(type)?.delete(listener as Listener);
  }
  dispatch(type: string, target: FakeImage): void {
    this.listeners.get(type)?.forEach((listener) => listener({ target } as unknown as Event));
  }
}

const OriginalImage = globalThis.HTMLImageElement;

afterEach(() => {
  Object.defineProperty(globalThis, "HTMLImageElement", { configurable: true, value: OriginalImage });
});

describe("image placeholder browser lifecycle", () => {
  it("installs capture listeners before scanning and handles cached success/error and lazy pending", () => {
    Object.defineProperty(globalThis, "HTMLImageElement", { configurable: true, value: FakeImage });
    const success = new FakeImage(); success.complete = true; success.naturalWidth = 100;
    const error = new FakeImage(); error.complete = true;
    const lazy = new FakeImage();
    const document = new FakeDocument([success, error, lazy]);
    document.querySelectorAll = () => { document.calls.push("scan"); return document.images; };
    const controller = ImagePlaceholderController.mount({ document: document as unknown as Document });
    expect(document.calls.slice(0, 4)).toEqual(["listen:load:true", "listen:error:true", "listen:zfb:after-swap:undefined", "scan"]);
    expect(success.wrapper.attributes.has("data-placeholder-loaded")).toBe(true);
    expect(error.wrapper.attributes.has("data-placeholder-error")).toBe(true);
    expect(lazy.wrapper.attributes.has("data-placeholder-pending")).toBe(true);
    lazy.naturalWidth = 100; document.dispatch("load", lazy);
    expect(lazy.wrapper.attributes.has("data-placeholder-pending")).toBe(false);
    const failedLater = new FakeImage();
    document.dispatch("error", failedLater);
    expect(failedLater.wrapper.attributes.has("data-placeholder-error")).toBe(true);
    controller?.destroy();
  });

  it("observes only added subtrees, closes the post-mark race, reconciles stale restore state, and destroys idempotently", () => {
    Object.defineProperty(globalThis, "HTMLImageElement", { configurable: true, value: FakeImage });
    const initial = new FakeImage();
    const document = new FakeDocument([initial]);
    let callback: MutationCallback = () => {};
    let disconnected = 0;
    const controller = ImagePlaceholderController.mount({
      document: document as unknown as Document,
      createObserver: (next) => {
        callback = next;
        return { observe() {}, disconnect() { disconnected += 1; } };
      },
    });

    const appended = new FakeImage();
    appended.wrapper.setAttribute("data-placeholder-loaded");
    appended.wrapper.setAttribute("data-placeholder-error");
    let completeReads = 0;
    Object.defineProperty(appended, "complete", {
      get() { completeReads += 1; return completeReads > 1; },
    });
    callback([{ addedNodes: [new FakeRoot([appended])] } as unknown as MutationRecord], {} as MutationObserver);
    expect(appended.wrapper.attributes.has("data-placeholder-pending")).toBe(false);
    expect(appended.wrapper.attributes.has("data-placeholder-error")).toBe(true);
    expect(appended.wrapper.attributes.has("data-placeholder-loaded")).toBe(false);

    initial.wrapper.setAttribute("data-placeholder-loaded");
    initial.complete = false;
    controller?.reconcile();
    expect(initial.wrapper.attributes.has("data-placeholder-loaded")).toBe(false);
    expect(initial.wrapper.attributes.has("data-placeholder-pending")).toBe(true);

    const routerReplacement = new FakeImage();
    document.images.splice(0, document.images.length, routerReplacement);
    document.dispatch("zfb:after-swap", routerReplacement);
    expect(routerReplacement.wrapper.attributes.has("data-placeholder-pending")).toBe(true);

    const replacement = new FakeImage();
    document.images.splice(0, document.images.length, replacement);
    const replacementController = ImagePlaceholderController.mount({ document: document as unknown as Document });
    expect(replacement.wrapper.attributes.has("data-placeholder-pending")).toBe(true);
    expect(disconnected).toBe(1);
    replacementController?.destroy();
    replacementController?.destroy();
    expect(document.listeners.get("load")?.size ?? 0).toBe(0);
  });
});
