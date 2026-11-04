import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import { normalizeTypedPath, typedPathErrorText } from './folderPath.js';

describe('normalizeTypedPath', () => {
  it('mantém um caminho Windows absoluto com espaços e acentos', () => {
    expect(normalizeTypedPath('C:\\Users\\joaop\\OneDrive\\Área de Trabalho')).toBe(
      'C:\\Users\\joaop\\OneDrive\\Área de Trabalho',
    );
  });

  it('tira espaços nas pontas', () => {
    expect(normalizeTypedPath('   C:\\projetos  \t')).toBe('C:\\projetos');
  });

  it('tira aspas duplas de um par nas pontas (Copiar como caminho do Explorer)', () => {
    expect(normalizeTypedPath('"C:\\Users\\joaop\\OneDrive"')).toBe('C:\\Users\\joaop\\OneDrive');
  });

  it('tira aspas simples de um par nas pontas', () => {
    expect(normalizeTypedPath("'C:\\projetos'")).toBe('C:\\projetos');
  });

  it('tira espaços que ficam dentro das aspas e depois delas', () => {
    expect(normalizeTypedPath('  " C:\\projetos "  ')).toBe('C:\\projetos');
  });

  it('aceita / como separador e converte para \\', () => {
    expect(normalizeTypedPath('C:/Users/joaop/OneDrive/Área de Trabalho')).toBe(
      'C:\\Users\\joaop\\OneDrive\\Área de Trabalho',
    );
  });

  it('não tira aspas que não formam um par', () => {
    expect(normalizeTypedPath('"C:\\projetos')).toBe('"C:\\projetos');
  });

  it('entrada vazia ou só com espaços vira string vazia', () => {
    expect(normalizeTypedPath('')).toBe('');
    expect(normalizeTypedPath('   ')).toBe('');
    expect(normalizeTypedPath('""')).toBe('');
  });

  it('raiz de unidade mantém a barra final', () => {
    expect(normalizeTypedPath('C:\\')).toBe('C:\\');
    expect(normalizeTypedPath('C:/')).toBe('C:\\');
  });
});

describe('typedPathErrorText', () => {
  it('403 outside_roots vira "Fora das pastas liberadas no PC"', () => {
    expect(typedPathErrorText(new ApiError('outside_roots', 403))).toBe('Fora das pastas liberadas no PC');
  });

  it('404 vira "Pasta não encontrada"', () => {
    expect(typedPathErrorText(new ApiError('not_found', 404))).toBe('Pasta não encontrada');
  });

  it('400 not_a_directory vira "Isso não é uma pasta"', () => {
    expect(typedPathErrorText(new ApiError('not_a_directory', 400))).toBe('Isso não é uma pasta');
  });

  it('outros erros usam o texto geral', () => {
    expect(typedPathErrorText(new ApiError('network'))).toBe(
      'Não consegui falar com o PC. Confira o endereço e se o Tailscale está conectado.',
    );
  });
});
