import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LoginStep } from '../accountLogin.js';
import { AccountLoginBody } from './AccountLoginSheet.js';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=xyz';

const noop = () => undefined;

function render(step: LoginStep | null, extra: { code?: string; sending?: boolean; codeProblem?: string | null; problem?: string | null } = {}): string {
  return renderToStaticMarkup(
    createElement(AccountLoginBody, {
      step,
      code: extra.code ?? '',
      sending: extra.sending ?? false,
      codeProblem: extra.codeProblem ?? null,
      problem: extra.problem ?? null,
      onCodeChange: noop,
      onSendCode: noop,
    }),
  );
}

const claudeLink = (patch: Partial<Extract<LoginStep, { kind: 'link' }>> = {}): LoginStep => ({
  kind: 'link',
  url: URL,
  userCode: null,
  needsCode: true,
  codeSent: false,
  ...patch,
});

const codexLink: LoginStep = {
  kind: 'link',
  url: 'https://auth.openai.com/codex/device',
  userCode: '0HKH-0YU99',
  needsCode: false,
  codeSent: false,
};

describe('AccountLoginBody: preparando', () => {
  it('mostra "Preparando…" e nada mais', () => {
    const html = render({ kind: 'starting' });
    expect(html).toContain('Preparando…');
    expect(html).toContain('data-step="starting"');
    expect(html).not.toContain('Abrir link');
  });
});

describe('AccountLoginBody: Claude (link e código colado)', () => {
  it('"Abrir link" é um link para outra aba, sem referrer nem acesso ao opener', () => {
    const html = render(claudeLink());
    expect(html).toContain('Abra o link e entre com a conta que você quer adicionar');
    const link = /<a [^>]*data-slot="login-link"[^>]*>/.exec(html)?.[0];
    expect(link).toBeDefined();
    expect(link).toContain(`href="${URL.replace(/&/g, '&amp;')}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Abrir link');
  });

  it('tem o botão de copiar o link', () => {
    expect(render(claudeLink())).toContain('aria-label="Copiar link"');
  });

  it('avisa que o PC pode abrir uma aba de login', () => {
    expect(render(claudeLink())).toContain('O PC também pode abrir uma aba de login; pode ignorar.');
  });

  it('pede o código com o campo e o botão "Enviar" (desabilitado sem texto)', () => {
    const html = render(claudeLink());
    expect(html).toContain('Depois de entrar, copie o código que aparece e cole aqui');
    expect(html).toContain('data-slot="login-code"');
    const send = /<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? '';
    expect(send).toContain('Enviar');
    expect(send).toContain('disabled=""');
    expect(html).toContain('Aguardando você entrar…');
    expect(html).not.toContain('login-user-code');
  });

  it('com código digitado o "Enviar" habilita; enviando mostra "Enviando…" e trava o campo', () => {
    const typed = render(claudeLink(), { code: 'abc#123' });
    const send = /<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/.exec(typed)?.[0] ?? '';
    expect(send).not.toContain('disabled=""');
    expect(typed).toContain('value="abc#123"');

    const sending = render(claudeLink(), { code: 'abc#123', sending: true });
    expect(sending).toContain('Enviando…');
    expect(/<input[^>]*data-slot="login-code"[^>]*>/.exec(sending)?.[0]).toContain('disabled=""');
  });

  it('o motivo da última tentativa aparece abaixo do campo', () => {
    expect(render(claudeLink(), { code: 'x', codeProblem: 'O login não está esperando um código agora.' })).toContain(
      'O login não está esperando um código agora.',
    );
  });

  it('depois de enviado: sem campo, e a linha de estado diz que o código foi enviado', () => {
    const html = render(claudeLink({ codeSent: true }));
    expect(html).not.toContain('data-slot="login-code"');
    expect(html).toContain('Código enviado. Aguardando o login terminar…');
  });
});

describe('AccountLoginBody: só links https', () => {
  it('um link que não começa com https:// não vira botão nem cópia', () => {
    for (const url of ['http://claude.com/login', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x', '//claude.com', ' https://claude.com']) {
      const html = render(claudeLink({ url }));
      expect(html).not.toContain('data-slot="login-link"');
      expect(html).not.toContain('Abrir link');
      expect(html).not.toContain('Copiar link');
      expect(html).not.toContain('href=');
      // The rest of the step stays: the field for the code and the status.
      expect(html).toContain('data-slot="login-code"');
      expect(html).toContain('Aguardando você entrar…');
    }
  });

  it('o código do Codex continua visível mesmo sem um link válido', () => {
    const html = render({ ...codexLink, url: 'http://auth.openai.com/codex/device' });
    expect(html).not.toContain('Abrir link');
    expect(html).toContain('0HKH-0YU99');
  });

  it('um link https:// continua sendo oferecido', () => {
    expect(render(claudeLink())).toContain('data-slot="login-link"');
  });
});

describe('AccountLoginBody: Codex (código para digitar)', () => {
  it('mostra o código grande, em fonte monoespaçada, com botão de copiar', () => {
    const html = render(codexLink);
    const code = /<span[^>]*data-slot="login-user-code"[^>]*>[\s\S]*?<\/span>/.exec(html)?.[0] ?? '';
    expect(code).toContain('0HKH-0YU99');
    expect(code).toContain('font-mono');
    expect(code).toContain('text-3xl');
    expect(html).toContain('aria-label="Copiar código"');
    expect(html).toContain('aria-label="Copiar link"');
  });

  it('não pede código colado nem fala da aba do PC', () => {
    const html = render(codexLink);
    expect(html).not.toContain('data-slot="login-code"');
    expect(html).not.toContain('Enviar');
    expect(html).not.toContain('O PC também pode abrir uma aba de login');
    expect(html).toContain('Aguardando você entrar…');
  });
});

describe('AccountLoginBody: fim do login', () => {
  it('verificando', () => {
    expect(render({ kind: 'verifying' })).toContain('Verificando…');
  });

  it('sucesso: "Conta conectada: <e-mail>"', () => {
    const html = render({ kind: 'success', account: 'pessoa@exemplo.com' });
    expect(html).toContain('Conta conectada: pessoa@exemplo.com');
    expect(html).toContain('data-step="success"');
  });

  it('falha: o motivo e a saída do login recolhida em fonte monoespaçada', () => {
    const html = render({ kind: 'failure', error: 'o login falhou (código 1)', output: 'Error: login was refused' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('O login falhou (código 1)');
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('Ver a saída do login');
    const pre = /<pre[^>]*>[\s\S]*?<\/pre>/.exec(html)?.[0] ?? '';
    expect(pre).toContain('font-mono');
    expect(pre).toContain('Error: login was refused');
  });

  it('falha sem saída não oferece o bloco recolhível', () => {
    const html = render({ kind: 'failure', error: 'tempo esgotado', output: '  \n' });
    expect(html).toContain('Tempo esgotado');
    expect(html).not.toContain('<details');
  });

  it('a saída vai como texto, nunca como HTML', () => {
    const html = render({ kind: 'failure', error: 'x', output: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
  });

  it('cancelado', () => {
    expect(render({ kind: 'cancelled' })).toContain('Login cancelado.');
  });
});

describe('AccountLoginBody: problemas', () => {
  it('login que não começou (step null): só o problema', () => {
    const html = render(null, { problem: 'Já há um login em andamento para este agente. Termine ou cancele esse primeiro.' });
    expect(html).toContain('Já há um login em andamento');
    expect(html).not.toContain('Preparando');
    expect(html).not.toContain('data-slot="login-status"');
  });

  it('falha passageira na consulta aparece junto do estado', () => {
    const html = render(claudeLink(), { problem: 'Sem resposta do PC. Tentando de novo…' });
    expect(html).toContain('Sem resposta do PC. Tentando de novo…');
    expect(html).toContain('Abrir link');
  });

  it('sem emoji em nenhuma etapa', () => {
    const steps: Array<LoginStep | null> = [
      { kind: 'starting' },
      claudeLink(),
      codexLink,
      { kind: 'verifying' },
      { kind: 'success', account: 'a@b.c' },
      { kind: 'failure', error: 'x', output: 'y' },
      { kind: 'cancelled' },
      null,
    ];
    for (const step of steps) expect(render(step)).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
