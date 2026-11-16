#!/usr/bin/env node
// NH Studio / NH Pocket app icons. The artwork itself lives in
// packages/ui-tokens/src/brand.ts (brandIconShapes), which the About pages
// draw too; this script only renders it to every file under
// New-Horizons-Gateway/brand/, so the platforms cannot drift apart:
//
//   brand/svg/        master SVGs (square full-bleed + rounded), favicons
//   brand/png/        1024 masters and the download-page sizes
//   brand/android/    NH Pocket adaptive icon layers (foreground, background,
//                     monochrome) + legacy icon, for Expo's app.json
//   brand/macos/      nh-studio.icns (Big Sur grid: 824 px body on 1024)
//   brand/windows/    nh-studio.ico (16-256, PNG-compressed entries), the
//                     installer wizard sidebar/header BMPs
//
// Run from ts/: node scripts/build-icons.mjs   (needs macOS iconutil for .icns,
// and Node 22.18+ to import brand.ts directly). It also writes the copies the
// apps bundle (Studio renderer mark + tray icon, Pocket assets).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { brandIconShapes } from '../packages/ui-tokens/src/brand.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../brand');

function scene(name, { small = false, parts = 'all', mono = null } = {}) {
  return brandIconShapes(name, { small, parts, mono })
    .map((s) =>
      s.stroke
        ? `<path d="${s.d}" fill="none" stroke="${s.stroke}" stroke-width="${s.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${s.opacity !== undefined ? ` opacity="${s.opacity}"` : ''}/>`
        : `<path d="${s.d}" fill="${s.fill}"${s.opacity !== undefined ? ` opacity="${s.opacity}"` : ''}/>`,
    )
    .join('\n    ');
}

/** A whole SVG document. `frame`: 'square' full-bleed, 'rounded' (rx 22%), or a custom inset. */
function svg(paletteName, { canvas = 100, inset = 0, radius = null, small = false, parts = 'all', mono = null, title } = {}) {
  const body = canvas - inset * 2;
  const scale = body / 100;
  const clip =
    radius === null
      ? `<rect x="${inset}" y="${inset}" width="${body}" height="${body}"/>`
      : `<rect x="${inset}" y="${inset}" width="${body}" height="${body}" rx="${radius}"/>`;
  const clipFrame = parts === 'all' || radius !== null;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}" width="${canvas}" height="${canvas}">
  <title>${title ?? (paletteName === 'studio' ? 'NH Studio' : 'NH Pocket')}</title>
  <defs><clipPath id="frame">${clip}</clipPath></defs>
  <g${clipFrame ? ' clip-path="url(#frame)"' : ''}>
    <g transform="translate(${inset} ${inset}) scale(${scale})">
    ${scene(paletteName, { small, parts, mono })}
    </g>
  </g>
</svg>
`;
}

function png(svgText, size) {
  return new Resvg(svgText, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

function write(rel, data) {
  const file = join(OUT, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}

/** ICO with PNG-compressed entries (Windows Vista+). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => Buffer.from(image.data))]);
}

const smallAt = (size) => size <= 32;

for (const name of ['studio', 'pocket']) {
  const id = `nh-${name}`;
  // Masters.
  write(`svg/${id}.svg`, svg(name));
  write(`svg/${id}-rounded.svg`, svg(name, { radius: 22 }));
  write(`svg/${id}-small.svg`, svg(name, { radius: 22, small: true }));
  write(`png/${id}-1024.png`, png(svg(name), 1024));
  for (const size of [512, 256, 128, 64]) write(`png/${id}-rounded-${size}.png`, png(svg(name, { radius: 22 }), size));
  for (const size of [32, 16]) write(`png/${id}-rounded-${size}.png`, png(svg(name, { radius: 22, small: true }), size));
}

// Web: the download page favicon and touch icon (Studio is the product mark).
write('svg/favicon.svg', svg('studio', { radius: 22, small: true }));
write('png/apple-touch-icon.png', png(svg('studio'), 180));

// NH Pocket on Android: adaptive layers are 108 dp; the inner 72 dp is what
// every launcher mask shows, so the 100-unit scene goes into the centre 72.
const adaptive = { canvas: 108, inset: 18 };
write('android/pocket-icon.png', png(svg('pocket'), 1024));
write('android/pocket-adaptive-background.png', png(svg('pocket', { ...adaptive, parts: 'background' }), 1024));
write('android/pocket-adaptive-foreground.png', png(svg('pocket', { ...adaptive, parts: 'foreground' }), 1024));
write('android/pocket-adaptive-monochrome.png', png(svg('pocket', { ...adaptive, parts: 'foreground', mono: '#ffffff' }), 1024));

// NH Studio on macOS: Big Sur grid, 824 px body (rx 185) centred on 1024.
const iconset = mkdtempSync(join(tmpdir(), 'nh-studio-'));
const iconsetDir = join(iconset, 'nh-studio.iconset');
mkdirSync(iconsetDir);
const mac = (size) => {
  const small = size <= 32;
  return png(svg('studio', { canvas: 1024, inset: 100, radius: 185, small }), size);
};
for (const [base, scales] of [[16, [1, 2]], [32, [1, 2]], [128, [1, 2]], [256, [1, 2]], [512, [1, 2]]]) {
  for (const s of scales) {
    writeFileSync(join(iconsetDir, `icon_${base}x${base}${s === 2 ? '@2x' : ''}.png`), mac(base * s));
  }
}
write('macos/nh-studio-1024.png', mac(1024));
let icnsWritten = false;
try {
  mkdirSync(join(OUT, 'macos'), { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', join(OUT, 'macos/nh-studio.icns')]);
  icnsWritten = true;
} catch (error) {
  console.warn(`iconutil unavailable (${error.message}); skipped nh-studio.icns`);
} finally {
  rmSync(iconset, { recursive: true, force: true });
}

// NH Studio on Windows: rounded square, full canvas.
const winSizes = [16, 24, 32, 48, 64, 128, 256];
write(
  'windows/nh-studio.ico',
  ico(winSizes.map((size) => ({ size, data: png(svg('studio', { radius: 22, small: smallAt(size) }), size) }))),
);

/** 24-bit BMP (what the NSIS wizard pages take) of an opaque SVG. */
function bmp(svgText) {
  const image = new Resvg(svgText).render();
  const { width, height } = image;
  const rgba = image.pixels;
  const stride = (width * 3 + 3) & ~3;
  const out = Buffer.alloc(54 + stride * height);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[row + x * 3] = rgba[i + 2];
      out[row + x * 3 + 1] = rgba[i + 1];
      out[row + x * 3 + 2] = rgba[i];
    }
  }
  return out;
}

// NH Studio's Windows installer wizard (electron-builder nsis): the welcome /
// finish sidebar (164x314: the Studio scene at the bottom, its sky above) and
// the page header (150x57: the rounded icon on the right, on white).
const studioSky = brandIconShapes('studio', { parts: 'background' })[0].fill;
write(
  'windows/installer-sidebar.bmp',
  bmp(`<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <rect width="164" height="314" fill="${studioSky}"/>
  <defs><clipPath id="c"><rect width="164" height="314"/></clipPath></defs>
  <g clip-path="url(#c)"><g transform="translate(0 150) scale(1.64)">
    ${scene('studio')}
  </g></g>
</svg>`),
);
write(
  'windows/installer-header.bmp',
  bmp(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  <defs><clipPath id="c"><rect x="99" y="6.5" width="44" height="44" rx="9.68"/></clipPath></defs>
  <g clip-path="url(#c)"><g transform="translate(99 6.5) scale(0.44)">
    ${scene('studio')}
  </g></g>
</svg>`),
);

// The copies the apps bundle themselves (written here so they cannot go
// stale): Studio's sidebar/splash mark and tray icon, Pocket's launcher icons.
const APPS = resolve(here, '../apps');
const appCopy = (rel, data) => {
  const file = join(APPS, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
appCopy('studio/src/renderer/assets/nh-studio-rounded.svg', svg('studio', { radius: 22 }));
appCopy('studio/public/tray-icon.png', png(svg('studio', { radius: 22, small: true }), 32));
appCopy('pocket/assets/icon.png', png(svg('pocket'), 1024));
appCopy('pocket/assets/android-icon-background.png', png(svg('pocket', { ...adaptive, parts: 'background' }), 1024));
appCopy('pocket/assets/android-icon-foreground.png', png(svg('pocket', { ...adaptive, parts: 'foreground' }), 1024));
appCopy('pocket/assets/android-icon-monochrome.png', png(svg('pocket', { ...adaptive, parts: 'foreground', mono: '#ffffff' }), 1024));
appCopy('pocket/assets/splash-icon.png', png(svg('pocket', { radius: 22 }), 1024));
appCopy('pocket/assets/favicon.png', png(svg('pocket', { radius: 22, small: true }), 48));

console.log(`icons written to ${OUT}${icnsWritten ? '' : ' (no .icns)'} and the apps' bundled copies`);
