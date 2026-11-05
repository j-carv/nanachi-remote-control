import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { CROP_PRESETS, croppedFileName, cropOutputMime, presetRatio, sourceRect } from './cropMath.js';

describe('sourceRect', () => {
  it('converte o recorte da imagem exibida para pixels do arquivo original', () => {
    // Exibida em 200x100, original 4000x2000: escala 20.
    const rect = sourceRect({ x: 10, y: 5, width: 50, height: 25 }, { width: 200, height: 100 }, { width: 4000, height: 2000 });
    expect(rect).toEqual({ x: 200, y: 100, width: 1000, height: 500 });
  });

  it('recorte que sai da imagem é cortado nas bordas', () => {
    const rect = sourceRect({ x: 150, y: 80, width: 100, height: 100 }, { width: 200, height: 100 }, { width: 200, height: 100 });
    expect(rect).toEqual({ x: 150, y: 80, width: 50, height: 20 });
  });

  it('origem negativa (arrasto para fora) vai para zero', () => {
    const rect = sourceRect({ x: -5, y: -3, width: 60, height: 40 }, { width: 100, height: 100 }, { width: 100, height: 100 });
    expect(rect).toEqual({ x: 0, y: 0, width: 55, height: 37 });
  });

  it('imagem exibida sem tamanho não gera recorte', () => {
    const rect = sourceRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 });
    expect(rect.width * rect.height).toBe(0);
  });

  it('recorte de largura quase nula vira no mínimo 1 px', () => {
    const rect = sourceRect({ x: 10, y: 10, width: 0.2, height: 0.2 }, { width: 100, height: 100 }, { width: 100, height: 100 });
    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });
});

describe('cropOutputMime', () => {
  it('JPEG sai como JPEG', () => {
    expect(cropOutputMime('image/jpeg')).toBe('image/jpeg');
  });

  it('PNG, WebP e GIF saem como PNG', () => {
    expect(cropOutputMime('image/png')).toBe('image/png');
    expect(cropOutputMime('image/webp')).toBe('image/png');
    expect(cropOutputMime('image/gif')).toBe('image/png');
  });

  it('mime desconhecido ou vazio sai como PNG', () => {
    expect(cropOutputMime('')).toBe('image/png');
  });
});

describe('croppedFileName', () => {
  it('troca a extensão pela do formato de saída', () => {
    expect(croppedFileName('foto.HEIC', 'image/png')).toBe('foto-recorte.png');
    expect(croppedFileName('viagem.jpeg', 'image/jpeg')).toBe('viagem-recorte.jpg');
  });

  it('nome sem extensão ganha o sufixo e a extensão', () => {
    expect(croppedFileName('captura', 'image/png')).toBe('captura-recorte.png');
  });
});

describe('presetRatio', () => {
  it('Livre não tem proporção fixa; os outros têm a proporção largura/altura', () => {
    expect(presetRatio('free')).toBeUndefined();
    expect(presetRatio('square')).toBe(1);
    expect(presetRatio('standard')).toBeCloseTo(4 / 3);
    expect(presetRatio('wide')).toBeCloseTo(16 / 9);
  });

  it('os rótulos são os da interface, na ordem Livre, 1:1, 4:3, 16:9', () => {
    expect(CROP_PRESETS.map((preset) => preset.label)).toEqual(['Livre', '1:1', '4:3', '16:9']);
  });
});

describe('crop texts in English', () => {
  it('names the free preset and the cropped file in English', () => {
    setLanguage('en');
    expect(CROP_PRESETS.map((preset) => preset.label)).toEqual(['Free', '1:1', '4:3', '16:9']);
    expect(croppedFileName('photo.jpeg', 'image/jpeg')).toBe('photo-cropped.jpg');
  });
});
