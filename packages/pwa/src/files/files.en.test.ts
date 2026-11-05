// The file and image components rendered in English (server-rendered, so effects do not run: the thumbnail is in its
// loading state). Portuguese is covered by the tests next to each file (the suite runs in pt-BR).
import type { FileInfo } from '@nanachi/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { FileAttachment } from '../components/FileAttachment.js';
import { ImageCropper } from '../components/ImageCropper.js';
import { ImageThumb } from '../components/ImageThumb.js';
import { setLanguage } from '../i18n/index.js';

const api = {} as ApiClient;
const noop = () => undefined;
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);

const PDF: FileInfo = { fileId: 'f-1', name: 'relatorio.pdf', mime: 'application/pdf', size: 2_621_440 };
const PNG: FileInfo = { fileId: 'f-2', name: 'foto.png', mime: 'image/png', size: 1024 };

describe('file components in English', () => {
  it('shows the download button and the size of a file card', () => {
    setLanguage('en');
    const rendered = html(createElement(FileAttachment, { api, file: PDF }));
    expect(rendered).toContain('relatorio.pdf');
    expect(rendered).toContain('2.5 MB');
    expect(rendered).toContain('>Download</button>');
  });

  it('names the image thumbnail while it loads', () => {
    setLanguage('en');
    expect(html(createElement(ImageThumb, { api, file: PNG }))).toContain('aria-label="Loading image"');
  });

  it('labels the cropper, its handles and its presets', () => {
    setLanguage('en');
    const rendered = html(
      createElement(ImageCropper, {
        src: 'blob:image',
        name: 'foto.png',
        mime: 'image/png',
        confirmLabel: 'Use crop',
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(rendered).toContain('>Crop</span>');
    expect(rendered).toContain('aria-label="Cancel crop"');
    expect(rendered).toContain('aria-label="Crop aspect ratio"');
    expect(rendered).toContain('>Free</button>');
    expect(rendered).toContain('Use crop');
  });
});
