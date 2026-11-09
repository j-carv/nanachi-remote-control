import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pngDataUrl, renderPairingHtml } from '../src/main/pages.js';
import { removeDir } from './remove-dir.js';

const QR = 'data:image/png;base64,AAAA';
const NONCE = 'bm9uY2Utbm9uY2Utbm9uY2U=';
const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const base = { code: '004217', expiresAt: 1_000_000 + 125_000, qrDataUrl: QR, nonce: NONCE, now: 1_000_000 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-pairing-logo-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('pairing page: app mark', () => {
  it('shows the mark as a decorative image above the title, inlined so the page stays under its own CSP', () => {
    const html = renderPairingHtml({ ...base, logoDataUrl: LOGO });
    const logo = html.indexOf(`<img class="logo" src="${LOGO}" alt="">`);
    expect(logo).toBeGreaterThan(-1);
    expect(logo).toBeLessThan(html.indexOf('<h1>'));
  });

  it('without a logo the page has no mark', () => {
    expect(renderPairingHtml(base)).not.toContain('class="logo"');
  });

  it('the content security policy still lets only data: images load', () => {
    const html = renderPairingHtml({ ...base, logoDataUrl: LOGO });
    expect(html).toContain("img-src data:;");
    expect(html).not.toContain("img-src 'self'");
  });

  it('refuses a mark that is not a PNG data URL, as it refuses a QR that is not one', () => {
    expect(() => renderPairingHtml({ ...base, logoDataUrl: 'https://evil.example/logo.png' })).toThrow();
    expect(() => renderPairingHtml({ ...base, logoDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })).toThrow();
  });
});

describe('pngDataUrl', () => {
  it('reads a PNG file into a data URL with its exact bytes', () => {
    const file = join(dir, 'icon-192.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(file, bytes);
    expect(pngDataUrl(file)).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
  });

  it('gives nothing when the file is missing: the pairing window then simply has no mark', () => {
    expect(pngDataUrl(join(dir, 'missing.png'))).toBeUndefined();
  });
});
