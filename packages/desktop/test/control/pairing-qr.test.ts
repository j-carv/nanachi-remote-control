import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { Language } from '../../src/common/i18n/index.js';
import { qrMatrix, qrPath } from '../../src/control/lib/qr.js';
import { PairingView } from '../../src/control/sections/DevicesSection.js';
import { html } from './render-helpers.js';

const noop = (): void => undefined;
const LINK = 'https://nanachi-office-pc.tail1234.ts.net/#pair=482915';

function view(extra: { link?: string | null; remainingMs?: number; onOpenTailscale?: () => void }, language: Language = 'pt-BR'): string {
  return html(
    createElement(PairingView, {
      code: '482915',
      remainingMs: extra.remainingMs ?? 272_000,
      fraction: 0.9,
      regenerating: false,
      onRegenerate: noop,
      onClose: noop,
      ...(extra.link !== undefined ? { link: extra.link } : {}),
      ...(extra.onOpenTailscale !== undefined ? { onOpenTailscale: extra.onOpenTailscale } : {}),
    }),
    language,
  );
}

describe('pairing QR code', () => {
  it('encodes the pairing link, and draws it dark on light with a quiet zone', () => {
    const markup = view({ link: LINK });
    expect(markup).toContain('<svg');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('width="176"');
    expect(markup).toContain('height="176"');
    expect(markup).toContain('fill="#ffffff"');
    expect(markup).toContain('fill="#000000"');
    expect(markup).toContain(qrPath(qrMatrix(LINK)).d);
  });

  it('is labelled for assistive technology in the language of the page', () => {
    expect(view({ link: LINK })).toContain('aria-label="QR code para parear o celular"');
  });

  it('is not dimmed while the code is live, says how to use it, and can copy the link', () => {
    const markup = view({ link: LINK });
    expect(markup).not.toContain('opacity-40');
    expect(markup).toContain('Aponte a câmera do celular');
    expect(markup).toContain('aria-label="Copiar link de pareamento"');
  });

  it('is dimmed and marked as expired once the code has run out, and the link is no longer copied', () => {
    const markup = view({ link: LINK, remainingMs: 0 });
    expect(markup).toContain('opacity-40');
    expect(markup).toContain('Este QR code expirou');
    expect(markup).not.toContain('Aponte a câmera do celular');
    expect(markup).not.toContain('aria-label="Copiar link de pareamento"');
  });

  it('speaks English in an English page, with the same texts', () => {
    const markup = view({ link: LINK }, 'en');
    expect(markup).toContain('aria-label="QR code for pairing the phone"');
    expect(markup).toContain('Scan it with the phone camera');
    expect(markup).toContain('aria-label="Copy pairing link"');
    expect(markup).not.toContain('Aponte');
    expect(markup).not.toContain('Copiar');
  });

  it('is not drawn without an origin: a line explains it, and it points to the Tailscale section', () => {
    const markup = view({ link: null, onOpenTailscale: noop });
    // The icons of the page are SVG too; the QR code is the one with the image role and the white field.
    expect(markup).not.toContain('role="img"');
    expect(markup).not.toContain('fill="#ffffff"');
    expect(markup).toContain('O Nanachi precisa de um endereço HTTPS no Tailscale para gerar o QR');
    expect(markup).toContain('Abrir o Tailscale');
  });

  it('keeps the six-digit code usable without the QR code, and without a button when none is given', () => {
    const markup = view({ link: null });
    expect(markup).toContain('482 915');
    expect(markup).not.toContain('Abrir o Tailscale');
  });
});
