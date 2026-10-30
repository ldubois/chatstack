// Génère les icônes de l'app (PNG + ICNS) et de la barre des menus depuis les SVG.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const iconsDir = path.join(__dirname, '..', 'assets', 'icons');

const traySvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">
  <path d="M6.5 2.5h6a1.5 1.5 0 0 1 1.5 1.5v3.5a1.5 1.5 0 0 1-1.5 1.5H12v1.5l-1.7-1.5" fill="none" stroke="#000" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M3.5 5.5h6A1.5 1.5 0 0 1 11 7v3.5A1.5 1.5 0 0 1 9.5 12H6l-2.5 2v-2A1.5 1.5 0 0 1 2 10.5V7a1.5 1.5 0 0 1 1.5-1.5z" fill="#000"/>
</svg>`;

async function main() {
  const svg = fs.readFileSync(path.join(iconsDir, 'icon.svg'));
  await sharp(svg).resize(512, 512).png().toFile(path.join(iconsDir, 'icon.png'));

  // .icns via iconutil (macOS)
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstack-')) + '/icon.iconset';
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await sharp(svg).resize(size, size).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
    await sharp(svg).resize(size * 2, size * 2).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(iconsDir, 'icon.icns')]);

  await sharp(Buffer.from(traySvg(16))).png().toFile(path.join(iconsDir, 'trayTemplate.png'));
  await sharp(Buffer.from(traySvg(32))).png().toFile(path.join(iconsDir, 'trayTemplate@2x.png'));
  console.log('Icônes générées dans', iconsDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
