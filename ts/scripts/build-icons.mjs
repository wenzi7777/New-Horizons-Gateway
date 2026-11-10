#!/usr/bin/env node
// NH Studio / NH Pocket app icons ("C": a planet rising behind one diagonal
// horizon line, the ground below it in shadow). Every file under
// New-Horizons-Gateway/brand/ is generated from the one scene below, so the
// platforms cannot drift apart:
//
//   brand/svg/        master SVGs (square full-bleed + rounded), favicons
//   brand/png/        1024 masters and the download-page sizes
//   brand/android/    NH Pocket adaptive icon layers (foreground, background,
//                     monochrome) + legacy icon, for Expo's app.json
//   brand/macos/      nh-studio.icns (Big Sur grid: 824 px body on 1024)
//   brand/windows/    nh-studio.ico (16-256, PNG-compressed entries)
//
// Run from ts/: node scripts/build-icons.mjs   (needs macOS iconutil for .icns)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../brand');

// Colours: the Desktop UI tokens' accent family (ui-tokens: accent #1f6b54,
// dark-mode accent family) on deep space.
const PALETTES = {
  studio: { sky: '#0b111c', planet: '#5fd4a3', ground: '#103a30', band: '#1f6b54', line: '#f2fbf6' },
  pocket: { sky: '#1f6b54', planet: '#f2fbf6', ground: '#081a16', band: '#0e2a23', line: '#5fd4a3' },
};

// The horizon: from (-5,75) to (105,44) in a 100-unit square, extended far
// past the edges so any crop or mask still shows a full-width line.
const SLOPE = (44 - 75) / 110;
const yAt = (x) => 75 + SLOPE * (x + 5);
const FAR = 200;

/**
 * Scene geometry in 100-unit space. `small` thickens the line and enlarges
 * the planet so 16-32 px renders keep their shape.
 */
function scene(p, { small = false, parts = 'all', mono = null } = {}) {
  const lineWidth = small ? 7.5 : 5;
  const r = small ? 18 : 16;
  const band = small ? 16 : 14;
  const x0 = -FAR;
  const x1 = 100 + FAR;
  const shapes = [];
  if (parts === 'all' || parts === 'background') {
    shapes.push(`<rect x="${x0}" y="${x0}" width="${x1 - x0}" height="${x1 - x0}" fill="${p.sky}"/>`);
  }
  if (parts === 'all' || parts === 'foreground') {
    shapes.push(`<circle cx="58" cy="50" r="${r}" fill="${mono ?? p.planet}"/>`);
  }
  if (parts === 'all' || parts === 'background') {
    shapes.push(`<path d="M${x0},${yAt(x0)} L${x1},${yAt(x1)} L${x1},${x1} L${x0},${x1} Z" fill="${p.ground}"/>`);
    shapes.push(
      `<path d="M${x0},${yAt(x0)} L${x1},${yAt(x1)} L${x1},${yAt(x1) + band} L${x0},${yAt(x0) + band} Z" fill="${p.band}"/>`,
    );
  }
  if (parts === 'foreground' && !mono) {
    // The planet sinks behind the ground: in the foreground layer the
    // ground is absent, so cut the planet at the horizon instead.
    shapes[shapes.length - 1] = `<clipPath id="above"><path d="M${x0},${x0} L${x1},${x0} L${x1},${yAt(x1)} L${x0},${yAt(x0)} Z"/></clipPath>
      <circle cx="58" cy="50" r="${r}" fill="${p.planet}" clip-path="url(#above)"/>`;
  }
  if (mono) {
    shapes[shapes.length - 1] = `<clipPath id="above"><path d="M${x0},${x0} L${x1},${x0} L${x1},${yAt(x1)} L${x0},${yAt(x0)} Z"/></clipPath>
      <circle cx="58" cy="50" r="${r}" fill="${mono}" clip-path="url(#above)"/>`;
  }
  shapes.push(
    `<path d="M${x0},${yAt(x0)} L${x1},${yAt(x1)}" fill="none" stroke="${mono ?? p.line}" stroke-width="${lineWidth}" stroke-linecap="round"/>`,
  );
  return shapes.join('\n    ');
}

/** A whole SVG document. `frame`: 'square' full-bleed, 'rounded' (rx 22%), or a custom inset. */
function svg(paletteName, { canvas = 100, inset = 0, radius = null, small = false, parts = 'all', mono = null, title } = {}) {
  const p = PALETTES[paletteName];
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
    ${scene(p, { small, parts, mono })}
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

console.log(`icons written to ${OUT}${icnsWritten ? '' : ' (no .icns)'}`);
