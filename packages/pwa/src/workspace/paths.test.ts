import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { breadcrumbs, formatSize, joinPath, parentOf, validateEntryName } from './paths.js';

describe('parentOf e joinPath', () => {
  it('pai de um item na raiz é a raiz', () => {
    expect(parentOf('a.ts')).toBe('');
  });

  it('pai de um caminho aninhado tira o último segmento', () => {
    expect(parentOf('src/screens/a.tsx')).toBe('src/screens');
  });

  it('juntar com a raiz não põe barra na frente', () => {
    expect(joinPath('', 'src')).toBe('src');
    expect(joinPath('src', 'app.ts')).toBe('src/app.ts');
  });
});

describe('breadcrumbs', () => {
  it('a raiz tem só o nome do workspace', () => {
    expect(breadcrumbs('', 'app')).toEqual([{ label: 'app', path: '' }]);
  });

  it('cada nível aponta para o caminho até ele', () => {
    expect(breadcrumbs('src/screens', 'app')).toEqual([
      { label: 'app', path: '' },
      { label: 'src', path: 'src' },
      { label: 'screens', path: 'src/screens' },
    ]);
  });
});

describe('validateEntryName', () => {
  it('aceita nome comum, com espaço e acento', () => {
    expect(validateEntryName('relatório final.md')).toBeNull();
  });

  it('nome vazio ou só espaço é recusado', () => {
    expect(validateEntryName('   ')).toBe('Digite um nome.');
  });

  it('barra no nome não cria pasta por engano', () => {
    expect(validateEntryName('a/b')).toBe('Use um nome sem barras.');
    expect(validateEntryName('a\\b')).toBe('Use um nome sem barras.');
  });

  it('ponto e ponto-ponto são recusados', () => {
    expect(validateEntryName('.')).toBe('Este nome não é permitido.');
    expect(validateEntryName('..')).toBe('Este nome não é permitido.');
  });

  it('caracteres que o Windows não aceita são recusados', () => {
    expect(validateEntryName('a:b')).toBe('Este nome não é permitido.');
    expect(validateEntryName('a*b')).toBe('Este nome não é permitido.');
  });

  it('nome terminando em ponto ou espaço é recusado', () => {
    expect(validateEntryName('arquivo.')).toBe('Este nome não é permitido.');
  });

  it('nome de dispositivo do Windows é recusado', () => {
    expect(validateEntryName('CON')).toBe('Este nome não é permitido.');
    expect(validateEntryName('lpt1.txt')).toBe('Este nome não é permitido.');
  });

  it('nome de até 255 caracteres passa', () => {
    expect(validateEntryName('a'.repeat(255))).toBeNull();
    expect(validateEntryName('a'.repeat(256))).toBe('Nome longo demais (máx. 255 caracteres).');
  });
});

describe('formatSize', () => {
  it('bytes, KB e MB em pt-BR', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1,5 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3,0 MB');
  });
});

describe('validateEntryName in English', () => {
  it('writes each refusal in English and still accepts a normal name', () => {
    setLanguage('en');
    expect(validateEntryName('relatório final.md')).toBeNull();
    expect(validateEntryName('   ')).toBe('Enter a name.');
    expect(validateEntryName('a/b')).toBe('Use a name without slashes.');
    expect(validateEntryName('CON')).toBe("This name isn't allowed.");
    expect(validateEntryName('a'.repeat(256))).toBe('Name too long (max 255 characters).');
  });
});

describe('formatSize in English', () => {
  it('uses a decimal point', () => {
    setLanguage('en');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
