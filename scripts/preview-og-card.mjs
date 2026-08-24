import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

import {
  BG,
  BLEED,
  BOX,
  CANVAS,
  PHOTO_BLEED_BOX,
  SHADOW_BLUR,
  SHADOW_BOX,
  SHADOW_OPACITY,
} from "../lib/og-card-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultOutputPath(inputPath) {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}-og-preview.jpg`);
}

async function render(inputPath, outputPath) {
  await access(inputPath);
  const [plate, shadowFill] = await Promise.all([
    readFile(path.join(root, "public", "og-plate.png")),
    readFile(path.join(root, "public", "og-shadow-fill.png")),
  ]);

  const photo = await sharp(inputPath)
    .rotate()
    .ensureAlpha()
    .resize(BOX.width, BOX.height, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Extend is intentional: a second contain/pad resize would upscale the photo.
  const alphaMask = await sharp(photo)
    .extractChannel("alpha")
    .linear(SHADOW_OPACITY)
    .extend({
      top: BLEED,
      bottom: BLEED,
      left: BLEED,
      right: BLEED,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .raw()
    .toBuffer();

  // Mask a pure-black source with the photo alpha. This avoids sharp's brightness:0 no-op.
  const blackPixels = await sharp(shadowFill)
    .resize(PHOTO_BLEED_BOX.width, PHOTO_BLEED_BOX.height, { fit: "fill", kernel: "nearest" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const shadow = await sharp(blackPixels, {
    raw: { width: PHOTO_BLEED_BOX.width, height: PHOTO_BLEED_BOX.height, channels: 3 },
  })
    .joinChannel(alphaMask, {
      raw: { width: PHOTO_BLEED_BOX.width, height: PHOTO_BLEED_BOX.height, channels: 1 },
    })
    .blur(SHADOW_BLUR)
    .png()
    .toBuffer();

  await sharp(plate)
    .composite([
      { input: shadow, left: SHADOW_BOX.x, top: SHADOW_BOX.y },
      { input: photo, left: BOX.x, top: BOX.y },
    ])
    .flatten({ background: BG })
    .jpeg({ quality: 90, chromaSubsampling: "4:4:4", optimiseCoding: false })
    .toFile(outputPath);
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error("Usage: node scripts/preview-og-card.mjs <image> [output.jpg]");
  process.exitCode = 1;
} else {
  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(outputArg ?? defaultOutputPath(inputPath));
  await render(inputPath, outputPath);
  const metadata = await sharp(outputPath).metadata();
  if (metadata.width !== CANVAS.width || metadata.height !== CANVAS.height) {
    throw new Error(`Unexpected preview dimensions: ${metadata.width}x${metadata.height}`);
  }
  console.log(outputPath);
}
