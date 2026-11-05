/*
 * Cores do realce de sintaxe: a única cor de código do app (ver docs/DESIGN.md, "Code highlighting"). O resto da
 * interface é monocromático. Cada papel é um tom baixo em croma, com contraste WCAG AA (4.5:1) sobre o fundo do
 * editor nos dois temas; o teste em codePalette.test.ts confere isso.
 */

/** Cor em OKLCH: luminosidade de 0 a 1, croma e matiz em graus. Mesma notação dos tokens `--ui-*`. */
export interface OklchColor {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** Papéis do realce. Cada um vira uma variável `--code-<papel>` no editor. */
export const CODE_ROLES = [
  'keyword',
  'string',
  'number',
  'comment',
  'type',
  'function',
  'property',
  'operator',
  'invalid',
] as const;

export type CodeRole = (typeof CODE_ROLES)[number];
export type CodeTheme = 'light' | 'dark';

/** Fundo do editor: o cartão (`--ui-card`) onde o editor fica. O editor é transparente sobre ele. */
export const CODE_BACKGROUND: Readonly<Record<CodeTheme, OklchColor>> = {
  light: { l: 1, c: 0, h: 0 },
  dark: { l: 0.19, c: 0, h: 0 },
};

/**
 * Palheta. Palavras-chave em violeta, strings em verde, números em âmbar, tipos em verde-azulado, funções e
 * decoradores em azul, propriedades e atributos em terracota. Comentários e operadores são cinza; `invalid` é o
 * vermelho de erro (`--ui-destructive`). No escuro, os mesmos matizes com luminosidade maior.
 */
export const CODE_PALETTE: Readonly<Record<CodeTheme, Readonly<Record<CodeRole, OklchColor>>>> = {
  light: {
    keyword: { l: 0.46, c: 0.13, h: 305 },
    string: { l: 0.48, c: 0.09, h: 150 },
    number: { l: 0.5, c: 0.1, h: 60 },
    comment: { l: 0.47, c: 0, h: 0 },
    type: { l: 0.5, c: 0.08, h: 200 },
    function: { l: 0.48, c: 0.12, h: 260 },
    property: { l: 0.5, c: 0.1, h: 25 },
    operator: { l: 0.4, c: 0, h: 0 },
    invalid: { l: 0.5, c: 0.15, h: 27 },
  },
  dark: {
    keyword: { l: 0.8, c: 0.1, h: 305 },
    string: { l: 0.82, c: 0.08, h: 150 },
    number: { l: 0.84, c: 0.09, h: 75 },
    comment: { l: 0.72, c: 0, h: 0 },
    type: { l: 0.82, c: 0.07, h: 200 },
    function: { l: 0.8, c: 0.1, h: 260 },
    property: { l: 0.8, c: 0.08, h: 25 },
    operator: { l: 0.78, c: 0, h: 0 },
    invalid: { l: 0.74, c: 0.13, h: 25 },
  },
};

export function oklchCss(color: OklchColor): string {
  return `oklch(${color.l} ${color.c} ${color.h})`;
}

/**
 * Variáveis CSS do editor: `--code-<papel>: light-dark(claro, escuro)`. `light-dark()` escolhe pelo `color-scheme`
 * do elemento; o editor fixa `color-scheme: light dark`, então cada par segue `prefers-color-scheme` sem media
 * query (o `EditorView.theme` não aceita `@media`).
 */
export function codeVariables(): Record<string, string> {
  return Object.fromEntries(
    CODE_ROLES.map((role) => [
      `--code-${role}`,
      `light-dark(${oklchCss(CODE_PALETTE.light[role])}, ${oklchCss(CODE_PALETTE.dark[role])})`,
    ]),
  );
}

/** Luminância relativa (WCAG) de uma cor OKLCH, com a conversão para sRGB linear da especificação do OKLab. */
function relativeLuminance({ l, c, h }: OklchColor): number {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lp = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mp = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sp = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const red = clamp(4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp);
  const green = clamp(-1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp);
  const blue = clamp(-0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** Razão de contraste WCAG entre duas cores (1 a 21). */
export function contrastRatio(a: OklchColor, b: OklchColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
