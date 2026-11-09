import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { RevokeDeviceBody } from './RevokeDeviceSheet.js';

const noop = () => undefined;

function render(extra: { busy?: boolean; error?: unknown } = {}): string {
  return renderToStaticMarkup(
    createElement(RevokeDeviceBody, {
      busy: extra.busy ?? false,
      error: extra.error ?? null,
      onCancel: noop,
      onConfirm: noop,
    }),
  );
}

describe('RevokeDeviceBody', () => {
  it('parado, sem erro: sem aviso e os dois botões ativos, o de confirmar com o texto Revogar', () => {
    const markup = render();

    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('>Revogar</button>');
    expect(markup).not.toContain('disabled=""');
  });

  it('durante a revogação: os dois botões travados e o de confirmar diz Revogando…', () => {
    const markup = render({ busy: true });

    expect(markup).toContain('Revogando…');
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });

  it('erro da revogação aparece no aviso, dentro da folha', () => {
    const markup = render({ error: new ApiError('network') });

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Não consegui falar com o PC.');
  });
});
