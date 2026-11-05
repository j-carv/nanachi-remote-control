import { croppedFileName, cropOutputMime, type Rect } from './cropMath.js';

/** Qualidade do JPEG gerado pelo recorte: visualmente sem perda, com arquivo bem menor que PNG para fotos. */
const JPEG_QUALITY = 0.92;

/**
 * Recorta uma imagem já carregada e devolve o arquivo novo. O formato segue o original (JPEG continua JPEG, o resto
 * vira PNG). `rect` está em pixels do arquivo original (ver sourceRect), não da tela.
 */
export async function cropImageToFile(
  image: HTMLImageElement,
  rect: Rect,
  source: { name: string; mime: string },
): Promise<File> {
  const mime = cropOutputMime(source.mime);
  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('canvas-unavailable');
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => (result === null ? reject(new Error('encode-failed')) : resolve(result)), mime, JPEG_QUALITY);
  });
  // Libera o buffer do canvas já: em iPhone, várias fotos grandes seguidas pesam na memória.
  canvas.width = 0;
  canvas.height = 0;
  return new File([blob], croppedFileName(source.name, mime), { type: mime });
}
