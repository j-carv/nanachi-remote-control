import { describe, expect, it } from 'vitest';
import {
  CODE_BACKGROUND,
  CODE_PALETTE,
  CODE_ROLES,
  codeVariables,
  contrastRatio,
  oklchCss,
  type CodeTheme,
} from './codePalette.js';

const WHITE = { l: 1, c: 0, h: 0 };
const BLACK = { l: 0, c: 0, h: 0 };
const THEMES: readonly CodeTheme[] = ['light', 'dark'];

describe('contrastRatio', () => {
  it('preto sobre branco dá 21:1, e a ordem não importa', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 1);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 1);
  });

  it('a mesma cor dá 1:1', () => {
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });
});

describe('CODE_PALETTE', () => {
  for (const theme of THEMES) {
    it(`${theme}: cada papel do realce passa WCAG AA (4.5:1) sobre o fundo do editor`, () => {
      for (const role of CODE_ROLES) {
        const ratio = contrastRatio(CODE_PALETTE[theme][role], CODE_BACKGROUND[theme]);
        expect(ratio, `${theme}/${role}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('cada papel existe nos dois temas', () => {
    for (const theme of THEMES) {
      for (const role of CODE_ROLES) {
        expect(CODE_PALETTE[theme][role], `${theme}/${role}`).toBeDefined();
      }
    }
  });
});

describe('oklchCss e codeVariables', () => {
  it('escreve a cor como oklch() do CSS', () => {
    expect(oklchCss({ l: 0.5, c: 0.1, h: 60 })).toBe('oklch(0.5 0.1 60)');
  });

  it('gera uma variável --code-<papel> por papel, com o par claro/escuro em light-dark()', () => {
    const variables = codeVariables();
    expect(Object.keys(variables).sort()).toEqual(CODE_ROLES.map((role) => `--code-${role}`).sort());
    expect(variables['--code-keyword']).toBe(
      `light-dark(${oklchCss(CODE_PALETTE.light.keyword)}, ${oklchCss(CODE_PALETTE.dark.keyword)})`,
    );
  });
});
