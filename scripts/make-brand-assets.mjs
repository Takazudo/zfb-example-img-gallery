import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

import { BG, CANVAS, LOGO_BOX } from "../lib/og-card-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const favicon = await readFile(path.join(publicDir, "favicon.svg"));

for (const [filename, size] of [
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]) {
  await sharp(favicon).resize(size, size).png().toFile(path.join(publicDir, filename));
}

const mark = await readFile(path.join(root, "assets", "brand", "takazudo-mark.svg"));
const markTile = await sharp(mark)
  .resize(LOGO_BOX.width, LOGO_BOX.height, { fit: "contain" })
  .png()
  .toBuffer();

const plate = await sharp({
  create: {
    width: CANVAS.width,
    height: CANVAS.height,
    channels: 3,
    background: BG,
  },
})
  .composite([{ input: markTile, left: LOGO_BOX.x, top: LOGO_BOX.y }])
  .png({ compressionLevel: 9, adaptiveFiltering: false })
  .toBuffer();

await sharp(plate).toFile(path.join(publicDir, "og-plate.png"));
await sharp({
  create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
})
  .png({ compressionLevel: 9, adaptiveFiltering: false })
  .toFile(path.join(publicDir, "og-shadow-fill.png"));
await sharp(plate)
  .flatten({ background: BG })
  .jpeg({ quality: 85, chromaSubsampling: "4:4:4", optimiseCoding: false })
  .toFile(path.join(publicDir, "og-fallback.jpg"));
