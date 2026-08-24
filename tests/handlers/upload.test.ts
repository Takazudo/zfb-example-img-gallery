import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../lib/env";
import type { PhotoStoreResult } from "../../lib/storage";

const h = vi.hoisted(() => ({
  ctx: null as unknown as { env: Env; request: Request },
  user: { id: 4, username: "uploader", email: "uploader@example.com", avatar_key: null },
  order: [] as string[],
}));

vi.mock("@takazudo/zfb-adapter-cloudflare", () => ({
  getCloudflareContext: () => h.ctx,
}));
vi.mock("../../lib/auth", () => ({
  getSessionUser: vi.fn(async () => h.user),
}));
vi.mock("../../lib/storage", () => ({
  MAX_UPLOAD_BYTES: 4 * 1024 * 1024,
  preprocessAndStorePhoto: vi.fn(async () => ({
    ok: true,
    key: "photos/123e4567-e89b-12d3-a456-426614174000.png",
    contentType: "image/png",
    ext: "png",
    size: 12,
    width: 640,
    height: 480,
    blurhash: "U4D]o#00fQ00~q00M{00M{~qRj~q",
  })),
  deleteObjects: vi.fn(async () => undefined),
}));
vi.mock("../../lib/db/photo-write", () => ({
  insertPhoto: vi.fn(async () => 23),
}));
// Expose the persistent helper so this test verifies the write-through uses the
// current-generation cache contract rather than the legacy renderer fallback.
vi.mock("../../lib/og", () => ({
  ensureOgCard: vi.fn(async () => {
    h.order.push("og");
    return new ArrayBuffer(0);
  }),
}));

import UploadPage from "../../pages/upload";
import { getSessionUser } from "../../lib/auth";
import { insertPhoto } from "../../lib/db/photo-write";
import { deleteObjects, preprocessAndStorePhoto } from "../../lib/storage";
import { ensureOgCard } from "../../lib/og";

const mockedStorage = vi.mocked(preprocessAndStorePhoto);
const mockedDelete = vi.mocked(deleteObjects);
const mockedInsert = vi.mocked(insertPhoto);
const mockedEnsure = vi.mocked(ensureOgCard);

const storageFailures: Array<[Extract<PhotoStoreResult, { ok: false }>, number, string]> = [
  [{ ok: false, reason: "too-large", size: 4 * 1024 * 1024 + 1, limit: 4 * 1024 * 1024 }, 413, "larger than 4 MB"],
  [{ ok: false, reason: "unsupported-type" }, 415, "not a supported"],
  [{ ok: false, reason: "undecodable" }, 415, "could not be decoded"],
];

function post(fields: Record<string, string>, file?: File, headers?: HeadersInit): Request {
  const form = new FormData();
  if (file) form.set("photo", file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("https://example.test/upload", { method: "POST", body: form, headers });
}

function file(name = "photo.jpg", bytes = "photo bytes", type = "image/jpeg"): File {
  return new File([bytes], name, { type });
}

async function invoke(request: Request): Promise<Response> {
  h.ctx = { env: {} as Env, request };
  return UploadPage();
}

beforeEach(() => {
  h.order.length = 0;
  h.user = { id: 4, username: "uploader", email: "uploader@example.com", avatar_key: null };
  mockedStorage.mockReset();
  mockedStorage.mockResolvedValue({
    ok: true,
    key: "photos/123e4567-e89b-12d3-a456-426614174000.png",
    contentType: "image/png",
    ext: "png",
    size: 12,
    width: 640,
    height: 480,
    blurhash: "U4D]o#00fQ00~q00M{00M{~qRj~q",
  });
  mockedDelete.mockReset();
  mockedDelete.mockResolvedValue(undefined);
  mockedInsert.mockReset();
  mockedInsert.mockImplementation(async () => {
    h.order.push("d1");
    return 23;
  });
  mockedEnsure.mockReset();
  mockedEnsure.mockImplementation(async () => {
    h.order.push("og");
    return new ArrayBuffer(0);
  });
  vi.mocked(getSessionUser).mockResolvedValue(h.user);
});

describe("/upload handler", () => {
  it("redirects signed-out visitors before reading a GET or POST body", async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    const get = await invoke(new Request("https://example.test/upload"));
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe("/login");

    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    const postResponse = await invoke(post({ title: "A title" }, file()));
    expect(postResponse.status).toBe(303);
    expect(postResponse.headers.get("location")).toBe("/login");
    expect(mockedStorage).not.toHaveBeenCalled();
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("renders the authenticated GET form with the multipart contract", async () => {
    const response = await invoke(new Request("https://example.test/upload"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('method="post" action="/upload" enctype="multipart/form-data"');
    expect(html).toContain('name="photo"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="tags"');
    expect(html).toContain('type="submit"');
    expect(html).toContain("comma separated, up to 10 tags");
  });

  it("rejects an oversized Content-Length before formData is called", async () => {
    const formData = vi.spyOn(Request.prototype, "formData");
    const response = await invoke(post({}, undefined, { "content-length": String(9 * 1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
    formData.mockRestore();
  });

  it.each(storageFailures)("maps storage failure %j to %i with a full form", async (result, status, message) => {
    mockedStorage.mockResolvedValueOnce(result);
    const response = await invoke(post({ title: "A title", description: "Notes", tags: "synth" }, file()));
    const html = await response.text();
    expect(response.status).toBe(status);
    expect(html).toContain(message);
    expect(html).toContain('role="alert"');
    expect(html).toContain('value="A title"');
    expect(html).toContain("Notes");
    expect(html).toContain('value="synth"');
    expect(html).toContain("select the photo again");
    expect(mockedInsert).not.toHaveBeenCalled();
  });

  it("rejects a missing or zero-byte file and preserves text fields", async () => {
    const response = await invoke(post({ title: " Typed title ", description: "Line 1\r\nLine 2", tags: "#synth" }, file("empty.jpg", "", "image/jpeg")));
    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain('value=" Typed title "');
    expect(html).toContain("Line 1\nLine 2");
    expect(html).toContain('value="#synth"');
    expect(html).toContain("non-empty photo");
  });

  it.each(["a/b", "a%b", "a?b", "a#b", "😀".repeat(33), "one,two,three,four,five,six,seven,eight,nine,ten,eleven"]) (
    "rejects invalid tag input %j", async (tags) => {
      const response = await invoke(post({ title: "A title", tags }, file()));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(`Tag &quot;${tags.includes(",") ? "eleven" : tags}&quot; is invalid`);
      expect(mockedStorage).not.toHaveBeenCalled();
    },
  );

  it("calls storage before D1 and OG after the committed row", async () => {
    mockedStorage.mockImplementationOnce(async () => {
      h.order.push("storage");
      return {
        ok: true,
        key: "photos/123e4567-e89b-12d3-a456-426614174000.png",
        contentType: "image/png",
        ext: "png",
        size: 12,
        width: 640,
        height: 480,
        blurhash: "U4D]o#00fQ00~q00M{00M{~qRj~q",
      };
    });
    const response = await invoke(post({ title: "A title", tags: " Synth , #Modular, synth ,, ENCLOSURE Deep " }, file("photo.jpg", "png", "image/jpeg")));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/photos/23");
    expect(h.order).toEqual(["storage", "d1", "og"]);
    expect(mockedInsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      title: "A title",
      contentType: "image/png",
      r2Key: "photos/123e4567-e89b-12d3-a456-426614174000.png",
      blurhash: "U4D]o#00fQ00~q00M{00M{~qRj~q",
      tags: ["synth", "modular", "enclosure-deep"],
    }));
    expect(mockedEnsure).toHaveBeenCalledWith(
      expect.anything(),
      "23",
      "photos/123e4567-e89b-12d3-a456-426614174000.png",
    );
  });

  it("keeps a committed row when OG generation rejects", async () => {
    mockedEnsure.mockRejectedValueOnce(new Error("Images unavailable"));
    const response = await invoke(post({ title: "A title" }, file()));
    expect(response.status).toBe(303);
    expect(mockedInsert).toHaveBeenCalledOnce();
  });

  it("passes a nullable preprocessing fallback through to D1", async () => {
    mockedStorage.mockResolvedValueOnce({
      ok: true,
      key: "photos/123e4567-e89b-12d3-a456-426614174000.png",
      contentType: "image/png",
      ext: "png",
      size: 12,
      width: 640,
      height: 480,
      blurhash: null,
    });
    const response = await invoke(post({ title: "A title" }, file()));
    expect(response.status).toBe(303);
    expect(mockedInsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ blurhash: null }));
  });

  it("deletes the just-written R2 key when the D1 write fails", async () => {
    mockedInsert.mockRejectedValueOnce(new Error("D1 failed"));
    const response = await invoke(post({ title: "A title", description: "Notes", tags: "synth" }, file()));
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain("Could not save your photo, please try again");
    expect(mockedDelete).toHaveBeenCalledOnce();
    expect(mockedDelete).toHaveBeenCalledWith(expect.anything(), ["photos/123e4567-e89b-12d3-a456-426614174000.png"]);
    expect(mockedEnsure).not.toHaveBeenCalled();
  });
});
