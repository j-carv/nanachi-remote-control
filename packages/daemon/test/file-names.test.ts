import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  isInlineMime,
  MAX_FILE_BYTES,
  normalizeMime,
  sanitizeFileName,
  servedMimeOf,
} from '../src/file-names.js';

describe('sanitizeFileName', () => {
  it('fica só com o basename, com / e \\ como separadores', () => {
    expect(sanitizeFileName('C:\\Users\\joao\\foto.png')).toBe('foto.png');
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('pasta/relatorio.pdf')).toBe('relatorio.pdf');
  });

  it('troca caracteres proibidos no Windows e controles por "_"', () => {
    expect(sanitizeFileName('a<b>c:d"e|f?g*h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
    expect(sanitizeFileName('nome\u0000\u001f\u007f.txt')).toBe('nome___.txt');
  });

  it('preserva acentos e espaços internos', () => {
    expect(sanitizeFileName('relatório final.pdf')).toBe('relatório final.pdf');
  });

  it('tira espaços e pontos do fim e das bordas (Windows não aceita)', () => {
    expect(sanitizeFileName('  a.txt. ')).toBe('a.txt');
  });

  it.each(['', '   ', '.', '..', '...', 'C:\\', 'pasta/'])('nome vazio ou inválido (%j) vira "arquivo"', (raw) => {
    expect(sanitizeFileName(raw)).toBe('arquivo');
  });

  it.each(['CON', 'con.txt', 'PRN', 'AUX.log', 'NUL', 'nul.txt', 'COM1', 'com9.bin', 'LPT1', 'lpt3.doc', 'COM¹.txt'])(
    'nome reservado do Windows (%s) ganha prefixo "_"',
    (raw) => {
      expect(sanitizeFileName(raw)).toBe(`_${raw}`);
    },
  );

  it('nomes que só começam com um reservado não são reservados', () => {
    expect(sanitizeFileName('CONSOLE.txt')).toBe('CONSOLE.txt');
    expect(sanitizeFileName('compras.txt')).toBe('compras.txt');
  });

  it('limita a 120 caracteres e preserva a extensão curta', () => {
    const name = `${'a'.repeat(300)}.pdf`;
    const result = sanitizeFileName(name);

    expect(result.length).toBe(120);
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('nome sem extensão longa é só cortado', () => {
    expect(sanitizeFileName('b'.repeat(200))).toBe('b'.repeat(120));
  });
});

describe('normalizeMime', () => {
  it('mantém o tipo e descarta parâmetros e caixa', () => {
    expect(normalizeMime('Image/PNG; charset=binary')).toBe('image/png');
  });

  it('valor ausente ou malformado vira application/octet-stream', () => {
    expect(normalizeMime(undefined)).toBe('application/octet-stream');
    expect(normalizeMime('')).toBe('application/octet-stream');
    expect(normalizeMime('lixo sem barra')).toBe('application/octet-stream');
    expect(normalizeMime('a/b/c')).toBe('application/octet-stream');
  });
});

describe('isInlineMime / servedMimeOf / contentDisposition', () => {
  it('só png, jpeg, gif e webp são inline; SVG, HEIC, BMP e o resto são attachment', () => {
    expect(isInlineMime('image/png')).toBe(true);
    expect(isInlineMime('image/jpeg')).toBe(true);
    expect(isInlineMime('image/gif')).toBe(true);
    expect(isInlineMime('image/webp')).toBe(true);
    expect(isInlineMime('image/svg+xml')).toBe(false);
    expect(isInlineMime('image/heic')).toBe(false);
    expect(isInlineMime('image/bmp')).toBe(false);
    expect(isInlineMime('application/pdf')).toBe(false);
    expect(isInlineMime('text/html')).toBe(false);
  });

  it('o Content-Type servido é o mime real só para raster inline; o resto vira application/octet-stream', () => {
    expect(servedMimeOf('image/png')).toBe('image/png');
    expect(servedMimeOf('image/webp')).toBe('image/webp');
    expect(servedMimeOf('text/html')).toBe('application/octet-stream');
    expect(servedMimeOf('image/svg+xml')).toBe('application/octet-stream');
    expect(servedMimeOf('application/pdf')).toBe('application/octet-stream');
  });

  it('usa RFC 5987 em filename* e um fallback ASCII', () => {
    expect(contentDisposition('relatório final.pdf', 'application/pdf')).toBe(
      `attachment; filename="relat_rio final.pdf"; filename*=UTF-8''relat%C3%B3rio%20final.pdf`,
    );
    expect(contentDisposition('ok.png', 'image/png')).toBe(`inline; filename="ok.png"; filename*=UTF-8''ok.png`);
  });

  it("codifica os caracteres que o RFC 5987 deixa de fora (' ( ) *)", () => {
    expect(contentDisposition("a'b(c)*.txt", 'text/plain')).toContain("filename*=UTF-8''a%27b%28c%29%2A.txt");
  });

  it('o limite de upload é 50 MiB', () => {
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  });
});
