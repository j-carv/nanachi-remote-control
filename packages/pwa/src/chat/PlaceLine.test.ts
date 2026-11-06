import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlaceLine } from './PlaceLine.js';

const PLACE = 'Nanachi-Remote · feature/chat-header · OFFICE-PC';

describe('PlaceLine', () => {
  it('keeps the whole place in a screen-reader-only copy, and hides the cut text from assistive tech', () => {
    const html = renderToStaticMarkup(createElement(PlaceLine, { text: PLACE }));

    expect(html).toContain('data-slot="session-place"');
    expect(html).toContain(`<span class="sr-only">${PLACE}</span>`);
    expect(html).toContain(`<span aria-hidden="true" title="${PLACE}" class="block truncate">`);
  });

  it('puts the tooltip on the hidden visible span, not on the paragraph, so the text is not announced twice', () => {
    const html = renderToStaticMarkup(createElement(PlaceLine, { text: PLACE }));
    const paragraphTag = html.match(/<p [^>]*>/)?.[0] ?? '';

    expect(paragraphTag).not.toBe('');
    expect(paragraphTag).not.toContain('title=');
  });

  it('uses the 14 px metadata size, not the 12 px it had', () => {
    const html = renderToStaticMarkup(createElement(PlaceLine, { text: PLACE }));

    expect(html).toContain('text-sm');
    expect(html).not.toContain('text-xs');
  });
});
