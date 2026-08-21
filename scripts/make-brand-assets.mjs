import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

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

// #007186 is the clipped sRGB rendering of styles/global.css's oklch(0.5 0.1 215) brand token.
const card = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#007186"/>
    <g transform="translate(492 207)">
      <rect x="0" y="0" width="216" height="216" rx="42" fill="none" stroke="#fff" stroke-width="18"/>
      <circle cx="108" cy="108" r="55" fill="none" stroke="#fff" stroke-width="18"/>
      <path d="M32 0v-28h88V0" fill="none" stroke="#fff" stroke-width="18" stroke-linejoin="round"/>
    </g>
    <text x="600" y="545" fill="#fff" font-family="ui-sans-serif,system-ui,sans-serif" font-size="82" font-weight="650" text-anchor="middle">Stillframe</text>
  </svg>
`);
await sharp(card).jpeg({ quality: 85 }).toFile(path.join(publicDir, "og-fallback.jpg"));
