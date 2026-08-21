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
