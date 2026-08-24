import type { Page } from "@playwright/test";
import { deflateSync } from "node:zlib";

/** 64x64 solid RGB PNG. Real bytes: passes magic-byte sniffing and IHDR dimension parsing. */
export const UPLOAD_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsGtk" +
  "NJPbwQi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" +
  "BAQEBAQELgs3Y7FpecoMbgAAAABJRU5ErkJggg==";

/** 1x1 transparent PNG used to stub `/img/**` responses. */
export const ONE_PX_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGA" +
  "hKmMIQAAAABJRU5ErkJggg==";

export const uploadPng = () => Buffer.from(UPLOAD_PNG_BASE64, "base64");
export const onePxPng = () => Buffer.from(ONE_PX_PNG_BASE64, "base64");

function pngCrc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Tiny valid PNGs with chosen intrinsic dimensions for Original-mode checks. */
export function pngWithDimensions(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const idat = deflateSync(raw);
  const chunk = (type: string, data: Buffer) => {
    const name = Buffer.from(type, "ascii");
    const crcInput = Buffer.concat([name, data]);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(pngCrc32(crcInput), 8 + data.length);
    return result;
  };
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Keep browser runs independent of local R2 contents and upload volume. */
export async function stubImageRequests(page: Page): Promise<void> {
  await page.route("**/img/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: onePxPng() }),
  );
}

/** Install a deterministic observer whose notifications tests trigger explicitly. */
export async function installIntersectionObserverStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      __e2eIntersectionObservers?: Array<{
        callback: IntersectionObserverCallback;
        target: Element | null;
        disconnected: boolean;
      }>;
    };
    const observers = win.__e2eIntersectionObservers ?? [];
    win.__e2eIntersectionObservers = observers;

    class ControlledIntersectionObserver {
      readonly callback: IntersectionObserverCallback;
      target: Element | null = null;
      disconnected = false;

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }

      observe(target: Element): void {
        this.target = target;
        this.disconnected = false;
      }

      unobserve(target: Element): void {
        if (this.target === target) this.target = null;
      }

      disconnect(): void {
        this.disconnected = true;
        this.target = null;
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: ControlledIntersectionObserver,
    });
  });
}

export async function triggerIntersection(page: Page, isIntersecting: boolean): Promise<void> {
  await page.evaluate((intersecting) => {
    const win = window as typeof window & {
      __e2eIntersectionObservers?: Array<{
        callback: IntersectionObserverCallback;
        target: Element | null;
        disconnected: boolean;
      }>;
    };
    for (const observer of win.__e2eIntersectionObservers ?? []) {
      if (observer.disconnected || !observer.target) continue;
      observer.callback(
        [{
          target: observer.target,
          isIntersecting: intersecting,
          intersectionRatio: intersecting ? 1 : 0,
          time: performance.now(),
          boundingClientRect: observer.target.getBoundingClientRect(),
          intersectionRect: intersecting ? observer.target.getBoundingClientRect() : new DOMRect(),
          rootBounds: null,
        } as IntersectionObserverEntry],
        observer as unknown as IntersectionObserver,
      );
    }
  }, isIntersecting);
}
