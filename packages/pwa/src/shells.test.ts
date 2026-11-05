import { describe, expect, it } from 'vitest';
import { orderShells, shellIdFromTitle } from './shells.js';

describe('shellIdFromTitle', () => {
  it('lê o shell do título "Terminal · <shell>" que o daemon grava', () => {
    expect(shellIdFromTitle('Terminal · pwsh')).toBe('pwsh');
    expect(shellIdFromTitle('Terminal · cmd')).toBe('cmd');
  });

  it('título que não é de terminal, ou shell desconhecido, devolve null', () => {
    expect(shellIdFromTitle('Corrigir build')).toBeNull();
    expect(shellIdFromTitle('Terminal · zsh')).toBeNull();
    expect(shellIdFromTitle('Terminal · ')).toBeNull();
  });
});

describe('orderShells', () => {
  it('coloca o shell padrão primeiro e mantém a ordem dos outros', () => {
    const ordered = orderShells([
      { id: 'cmd', label: 'Prompt de Comando', isDefault: false },
      { id: 'powershell', label: 'Windows PowerShell', isDefault: false },
      { id: 'pwsh', label: 'PowerShell 7', isDefault: true },
    ]);
    expect(ordered.map((shell) => shell.id)).toEqual(['pwsh', 'cmd', 'powershell']);
  });

  it('lista sem padrão segue na ordem que chegou', () => {
    const ordered = orderShells([
      { id: 'cmd', label: 'Prompt de Comando', isDefault: false },
      { id: 'bash', label: 'Git Bash', isDefault: false },
    ]);
    expect(ordered.map((shell) => shell.id)).toEqual(['cmd', 'bash']);
  });
});
