import { useMemo } from 'react';
import { qrMatrix, qrPath } from '../lib/qr.js';
import { cx } from './cx.js';

export interface QrCodeProps {
  /** What the code carries. */
  text: string;
  /** Side of the drawing on screen, in CSS pixels. */
  size: number;
  /** Read aloud by assistive technology. */
  label: string;
  /** Faded, for a code that must no longer be scanned. */
  dimmed?: boolean;
}

/**
 * A QR code as an inline SVG: dark modules on a white field, with the quiet zone inside the drawing, whatever the theme. It is
 * markup rather than an image, so the page's policy needs nothing extra.
 */
export function QrCode({ text, size, label, dimmed = false }: QrCodeProps) {
  const drawing = useMemo(() => qrPath(qrMatrix(text)), [text]);
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${drawing.viewBox} ${drawing.viewBox}`}
      shapeRendering="crispEdges"
      className={cx('block shrink-0 transition-[opacity,filter] duration-200', dimmed && 'opacity-40 grayscale')}
    >
      <rect width={drawing.viewBox} height={drawing.viewBox} fill="#ffffff" />
      <path d={drawing.d} fill="#000000" />
    </svg>
  );
}
