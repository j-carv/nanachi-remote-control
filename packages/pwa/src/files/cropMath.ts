/**
 * Matemática do recorte, sem DOM: o componente desenha a moldura na imagem exibida, e isto converte o retângulo
 * para os pixels do arquivo original, escolhe o formato de saída e o nome do arquivo.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CropPresetId = 'free' | 'square' | 'standard' | 'wide';

/** Presets do recorte, na ordem da barra. `ratio` é largura/altura; `undefined` deixa a moldura livre. */
export const CROP_PRESETS: readonly { id: CropPresetId; label: string; ratio: number | undefined }[] = [
  { id: 'free', label: 'Livre', ratio: undefined },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: 'standard', label: '4:3', ratio: 4 / 3 },
  { id: 'wide', label: '16:9', ratio: 16 / 9 },
];

export function presetRatio(id: CropPresetId): number | undefined {
  return CROP_PRESETS.find((preset) => preset.id === id)?.ratio;
}

/**
 * Converte o retângulo desenhado sobre a imagem exibida (em px de tela) para o retângulo em pixels do arquivo.
 * A origem arredonda para baixo e o fim para o inteiro mais próximo; o resultado fica dentro da imagem e tem
 * pelo menos 1 px. Sem tamanho exibido, o retângulo é vazio.
 */
export function sourceRect(crop: Rect, shown: Size, natural: Size): Rect {
  if (shown.width <= 0 || shown.height <= 0 || natural.width < 1 || natural.height < 1) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scaleX = natural.width / shown.width;
  const scaleY = natural.height / shown.height;
  const x = clamp(Math.floor(crop.x * scaleX), 0, natural.width - 1);
  const y = clamp(Math.floor(crop.y * scaleY), 0, natural.height - 1);
  const right = clamp(Math.round((crop.x + crop.width) * scaleX), x + 1, natural.width);
  const bottom = clamp(Math.round((crop.y + crop.height) * scaleY), y + 1, natural.height);
  return { x, y, width: right - x, height: bottom - y };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type CropOutputMime = 'image/jpeg' | 'image/png';

/** JPEG continua JPEG (foto sem transparência, arquivo menor). Qualquer outro formato sai como PNG, sem perda. */
export function cropOutputMime(sourceMime: string): CropOutputMime {
  const normalized = sourceMime.toLowerCase();
  return normalized === 'image/jpeg' || normalized === 'image/jpg' ? 'image/jpeg' : 'image/png';
}

/** Nome do recorte: o nome original com `-recorte` e a extensão do formato de saída. */
export function croppedFileName(name: string, outputMime: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = outputMime === 'image/jpeg' ? 'jpg' : 'png';
  return `${base}-recorte.${extension}`;
}
