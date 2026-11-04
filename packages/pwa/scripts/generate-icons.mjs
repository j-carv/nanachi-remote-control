// Gera os ícones PNG da PWA em public/ sem dependências externas (só Node: zlib, fs, path, url).
// Uso: npm run icons -w @nanachi/pwa
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BACKGROUND = [11, 13, 18]; // #0b0d12, igual ao theme_color
const ACCENT = [124, 92, 255]; // círculo
const LETTER = [245, 247, 255]; // "N"
const SAMPLES = 4; // subamostragem 4x4 para bordas suavizadas

/** Cobertura (0..1) de um ponto (x, y) em coordenadas unitárias [0, 1]. */
function circleCoverage(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  return dx * dx + dy * dy <= 0.42 * 0.42 ? 1 : 0;
}

function insideRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

/** Distância de (x, y) até o segmento (ax, ay)-(bx, by). */
function distanceToSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  const px = ax + t * vx - x;
  const py = ay + t * vy - y;
  return Math.sqrt(px * px + py * py);
}

/** Letra "N" feita de duas barras e uma diagonal (cápsula). */
function letterNCoverage(x, y) {
  const bar = insideRect(x, y, 0.36, 0.3, 0.44, 0.7) || insideRect(x, y, 0.56, 0.3, 0.64, 0.7);
  const diagonal = distanceToSegment(x, y, 0.4, 0.3, 0.6, 0.7) <= 0.045 && y >= 0.3 && y <= 0.7;
  return bar || diagonal ? 1 : 0;
}

function renderPixel(px, py, size) {
  let circleHits = 0;
  let letterHits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const x = (px + (sx + 0.5) / SAMPLES) / size;
      const y = (py + (sy + 0.5) / SAMPLES) / size;
      circleHits += circleCoverage(x, y);
      letterHits += letterNCoverage(x, y);
    }
  }
  const total = SAMPLES * SAMPLES;
  const circle = circleHits / total;
  const letter = letterHits / total;
  return BACKGROUND.map((bg, i) => {
    const withCircle = bg * (1 - circle) + ACCENT[i] * circle;
    return Math.round(withCircle * (1 - letter) + LETTER[i] * letter);
  });
}

/** PNG RGB 8 bits, sem filtro (filtro 0 em todas as linhas). */
function encodePng(size) {
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = renderPixel(x, y, size);
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // profundidade de bits
  header[9] = 2; // RGB (sem alpha: ícones do iOS não podem ter transparência)
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const ICONS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size } of ICONS) {
  writeFileSync(join(OUT_DIR, file), encodePng(size));
  console.log(`ok ${file} (${size}x${size})`);
}
