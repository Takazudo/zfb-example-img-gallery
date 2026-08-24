/**
 * Small, genuinely decodable image fixtures shared by local bindings and the browser lane.
 * Base64 keeps these bytes portable to the Workers isolate (without Node-only sharp).
 */
export type ImageFixture = {
  name: "jpeg" | "png" | "webp";
  contentType: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
  bytes: Uint8Array;
};

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function fixture(
  name: ImageFixture["name"],
  contentType: ImageFixture["contentType"],
  ext: ImageFixture["ext"],
  width: number,
  height: number,
  base64: string,
): ImageFixture {
  return { name, contentType, ext, width, height, bytes: decodeBase64(base64) };
}

export const JPEG_FIXTURE = fixture(
  "jpeg",
  "image/jpeg",
  "jpg",
  8,
  4,
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAEWN/9k=",
);

export const PNG_FIXTURE = fixture(
  "png",
  "image/png",
  "png",
  6,
  5,
  "iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAYAAABmWJ3mAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGMQWfDsDDbMQAcJAG4cR/Xn+WWaAAAAAElFTkSuQmCC",
);

export const WEBP_FIXTURE = fixture(
  "webp",
  "image/webp",
  "webp",
  7,
  3,
  "UklGRh4AAABXRUJQVlA4TBEAAAAvBoAAAAdQ5EJVq/+BiOh/AAA=",
);

export const REAL_IMAGE_FIXTURES = [JPEG_FIXTURE, PNG_FIXTURE, WEBP_FIXTURE] as const;

export function imageFixtureArrayBuffer(fixture: ImageFixture): ArrayBuffer {
  return fixture.bytes.buffer.slice(
    fixture.bytes.byteOffset,
    fixture.bytes.byteOffset + fixture.bytes.byteLength,
  ) as ArrayBuffer;
}
