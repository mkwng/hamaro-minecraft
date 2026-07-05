// Rasterize the social/OG assets into public/ (shipped verbatim by Vite).
//   node assets/make-social.mjs
import sharp from "sharp";
import { mkdirSync } from "node:fs";

mkdirSync("public", { recursive: true });
await sharp("assets/og.svg").png().toFile("public/og.png");

// App icon: the grass block on black, 180px (apple-touch-icon).
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
  <rect width="180" height="180" fill="#0c0e0b"/>
  <rect x="26" y="26" width="128" height="57" fill="#78b943"/>
  <rect x="26" y="26" width="18" height="18" fill="#8ecf57"/>
  <rect x="98" y="47" width="18" height="18" fill="#5a9430"/>
  <rect x="26" y="83" width="128" height="71" fill="#7a5a3a"/>
  <rect x="62" y="101" width="18" height="18" fill="#8a6a48"/>
  <rect x="116" y="119" width="18" height="18" fill="#684a2e"/>
</svg>`;
await sharp(Buffer.from(icon)).png().toFile("public/icon-180.png");
console.log("wrote public/og.png + public/icon-180.png");
