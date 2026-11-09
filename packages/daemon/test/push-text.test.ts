import { APP_LANGUAGES } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { PUSH_TEXT, pushTextOf } from '../src/push-text.js';

describe('pushTextOf', () => {
  it('uses pt-BR when there is no language (older subscription)', () => {
    expect(pushTextOf(null)).toBe(PUSH_TEXT['pt-BR']);
    expect(pushTextOf(undefined)).toBe(PUSH_TEXT['pt-BR']);
  });

  it('returns the dictionary of the requested language', () => {
    expect(pushTextOf('en')).toBe(PUSH_TEXT.en);
    expect(pushTextOf('es')).toBe(PUSH_TEXT.es);
  });
});

describe('PUSH_TEXT', () => {
  it('has one dictionary per app language', () => {
    expect(Object.keys(PUSH_TEXT).sort()).toEqual([...APP_LANGUAGES].sort());
  });

  it('keeps the pt-BR texts the daemon has always sent', () => {
    const text = PUSH_TEXT['pt-BR'];
    expect(text.loopPausedTitle).toBe('Loop pausado');
    expect(text.pairedTitle).toBe('Nanachi Remote');
    expect(text.turnEnd('Refatorar login')).toBe('Terminou: Refatorar login');
    expect(text.terminalExit).toBe('Terminal encerrado');
    expect(text.permissionRequest('Editar src/a.ts')).toBe('Pede aprovação: Editar src/a.ts');
    expect(text.permissionRequestUntitled).toBe('Pede aprovação');
    expect(text.error('falhou')).toBe('Erro: falhou');
    expect(text.fileRequest('Documento')).toBe('Precisa de um arquivo: Documento');
    expect(text.preview('App')).toBe('Pré-visualização disponível: App');
    expect(text.file('print.png')).toBe('Arquivo: print.png');
    expect(text.loopPaused('Refatorar login', 'agente caiu')).toBe('Refatorar login: agente caiu');
    expect(text.devicePaired('iPhone')).toBe('Novo aparelho entrou com Tailscale: iPhone');
  });

  it('has English texts for every kind of push', () => {
    const text = PUSH_TEXT.en;
    expect(text.loopPausedTitle).toBe('Loop paused');
    expect(text.pairedTitle).toBe('Nanachi Remote');
    expect(text.turnEnd('Refactor login')).toBe('Finished: Refactor login');
    expect(text.terminalExit).toBe('Terminal closed');
    expect(text.permissionRequest('Edit src/a.ts')).toBe('Needs approval: Edit src/a.ts');
    expect(text.permissionRequestUntitled).toBe('Needs approval');
    expect(text.error('failed')).toBe('Error: failed');
    expect(text.fileRequest('Document')).toBe('Needs a file: Document');
    expect(text.preview('App')).toBe('Preview available: App');
    expect(text.file('print.png')).toBe('File: print.png');
    expect(text.loopPaused('Refactor login', 'agent crashed')).toBe('Refactor login: agent crashed');
    expect(text.devicePaired('iPhone')).toBe('New device joined with Tailscale: iPhone');
  });

  it('has Spanish texts for every kind of push', () => {
    const text = PUSH_TEXT.es;
    expect(text.loopPausedTitle).toBe('Loop pausado');
    expect(text.pairedTitle).toBe('Nanachi Remote');
    expect(text.turnEnd('Refactorizar login')).toBe('Terminó: Refactorizar login');
    expect(text.terminalExit).toBe('Terminal cerrada');
    expect(text.permissionRequest('Editar src/a.ts')).toBe('Necesita aprobación: Editar src/a.ts');
    expect(text.permissionRequestUntitled).toBe('Necesita aprobación');
    expect(text.error('falló')).toBe('Error: falló');
    expect(text.fileRequest('Documento')).toBe('Necesita un archivo: Documento');
    expect(text.preview('App')).toBe('Vista previa disponible: App');
    expect(text.file('print.png')).toBe('Archivo: print.png');
    expect(text.loopPaused('Refactorizar login', 'el agente se cayó')).toBe('Refactorizar login: el agente se cayó');
    expect(text.devicePaired('iPhone')).toBe('Nuevo dispositivo se unió con Tailscale: iPhone');
  });

  it('leaves no Portuguese in the en and es texts', () => {
    const portugueseWords = /Terminou|Pede|Erro:|Arquivo|aparelho|encerrado|Novo /;
    for (const language of ['en', 'es'] as const) {
      const text = PUSH_TEXT[language];
      const samples = [
        text.loopPausedTitle,
        text.terminalExit,
        text.permissionRequestUntitled,
        text.turnEnd('x'),
        text.permissionRequest('x'),
        text.fileRequest('x'),
        text.preview('x'),
        text.error('x'),
        text.file('x'),
        text.devicePaired('x'),
      ];
      for (const sample of samples) expect(sample).not.toMatch(portugueseWords);
    }
  });
});
