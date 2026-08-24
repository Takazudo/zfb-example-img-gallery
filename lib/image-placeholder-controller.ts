const IMAGE_SELECTOR = 'img[data-placeholder-image="true"]';
const WRAPPER_SELECTOR = '[data-image-placeholder="true"]';

type Observer = Pick<MutationObserver, "observe" | "disconnect">;
type ObserverFactory = (callback: MutationCallback) => Observer;

export type ImagePlaceholderEnvironment = {
  document: Document;
  createObserver?: ObserverFactory;
};

const activeControllers = new WeakMap<Document, ImagePlaceholderController>();

function defaultEnvironment(): ImagePlaceholderEnvironment | null {
  if (typeof document === "undefined") return null;
  return {
    document,
    ...(typeof MutationObserver === "undefined"
      ? {}
      : { createObserver: (callback: MutationCallback) => new MutationObserver(callback) }),
  };
}

export class ImagePlaceholderController {
  readonly #environment: ImagePlaceholderEnvironment;
  #observer: Observer | null = null;
  #destroyed = false;

  static mount(environment = defaultEnvironment()): ImagePlaceholderController | null {
    if (!environment) return null;
    activeControllers.get(environment.document)?.destroy();
    const controller = new ImagePlaceholderController(environment);
    activeControllers.set(environment.document, controller);
    return controller;
  }

  private constructor(environment: ImagePlaceholderEnvironment) {
    this.#environment = environment;
    // Capture-phase listeners must exist before the first scan: cached images can
    // settle while initial reconciliation is walking the document.
    environment.document.addEventListener("load", this.#onSettle, true);
    environment.document.addEventListener("error", this.#onSettle, true);
    environment.document.addEventListener("zfb:after-swap", this.#onAfterSwap);
    if (environment.createObserver) {
      this.#observer = environment.createObserver(this.#onMutations);
      this.#observer.observe(environment.document, { childList: true, subtree: true });
    }
    this.reconcile(environment.document);
  }

  /** Reset serialized/stale state, then resolve every image currently under root. */
  reconcile(root: ParentNode = this.#environment.document): void {
    this.#images(root).forEach((image) => this.#prepare(image, true));
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#observer?.disconnect();
    this.#environment.document.removeEventListener("load", this.#onSettle, true);
    this.#environment.document.removeEventListener("error", this.#onSettle, true);
    this.#environment.document.removeEventListener("zfb:after-swap", this.#onAfterSwap);
    if (activeControllers.get(this.#environment.document) === this) {
      activeControllers.delete(this.#environment.document);
    }
  }

  #images(root: ParentNode): HTMLImageElement[] {
    const images: HTMLImageElement[] = [];
    const element = root as ParentNode & { nodeType?: number; matches?: (selector: string) => boolean };
    if (element.nodeType === 1 && element.matches?.(IMAGE_SELECTOR)) images.push(root as HTMLImageElement);
    root.querySelectorAll<HTMLImageElement>(IMAGE_SELECTOR).forEach((image) => images.push(image));
    return images;
  }

  #wrapper(image: HTMLImageElement): HTMLElement | null {
    const wrapper = image.closest<HTMLElement>(WRAPPER_SELECTOR);
    return wrapper?.contains(image) ? wrapper : null;
  }

  #reveal(image: HTMLImageElement): void {
    const wrapper = this.#wrapper(image);
    if (!wrapper) return;
    wrapper.removeAttribute("data-placeholder-pending");
    wrapper.removeAttribute("data-placeholder-loaded");
    wrapper.removeAttribute("data-placeholder-error");
    wrapper.setAttribute(image.naturalWidth > 0 ? "data-placeholder-loaded" : "data-placeholder-error", "true");
  }

  #prepare(image: HTMLImageElement, reset: boolean): void {
    const wrapper = this.#wrapper(image);
    if (!wrapper) return;
    if (reset) {
      wrapper.removeAttribute("data-placeholder-pending");
      wrapper.removeAttribute("data-placeholder-loaded");
      wrapper.removeAttribute("data-placeholder-error");
    }
    if (image.complete) {
      this.#reveal(image);
      return;
    }
    wrapper.setAttribute("data-placeholder-pending", "true");
    // Close the completion race between the `complete` read and pending mark.
    if (image.complete) this.#reveal(image);
  }

  readonly #onSettle = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLImageElement && target.matches(IMAGE_SELECTOR)) this.#reveal(target);
  };

  readonly #onAfterSwap = (): void => {
    this.reconcile(this.#environment.document);
  };

  readonly #onMutations: MutationCallback = (records): void => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) this.#images(node as unknown as ParentNode).forEach((image) => this.#prepare(image, true));
      }
    }
  };
}
