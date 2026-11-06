import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScreenHeader } from './ScreenHeader.js';

const SUBTITLE = 'OFFICE-PC · C:\\Projects\\nanachi';

describe('ScreenHeader subtitle', () => {
  it('cuts a long subtitle at the end by default, as every other screen does', () => {
    const html = renderToStaticMarkup(createElement(ScreenHeader, { title: 'nanachi', subtitle: SUBTITLE }));

    expect(html).toContain(`<p class="truncate text-sm text-muted-foreground">${SUBTITLE}</p>`);
    expect(html).not.toContain('data-slot="session-place"');
  });

  it('renders the place line with the full subtitle for screen readers (the middle cut itself runs in the browser)', () => {
    const html = renderToStaticMarkup(
      createElement(ScreenHeader, { title: 'nanachi', subtitle: SUBTITLE, subtitleTruncation: 'middle' }),
    );

    expect(html).toContain('data-slot="session-place"');
    expect(html).toContain(`<span class="sr-only">${SUBTITLE}</span>`);
    expect(html).not.toContain('<p class="truncate');
  });
});
