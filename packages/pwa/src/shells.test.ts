import { describe, expect, it } from 'vitest';
import { orderShells } from './shells.js';

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
