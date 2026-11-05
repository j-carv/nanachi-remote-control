import { useRef, useState, type SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactCrop, { centerCrop, convertToPixelCrop, makeAspectCrop, type PercentCrop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CROP_PRESETS, presetRatio, sourceRect, type CropPresetId } from '../files/cropMath.js';
import { cropImageToFile } from '../files/cropImage.js';

interface ImageCropperProps {
  /** `blob:` URL da imagem a recortar. */
  src: string;
  name: string;
  mime: string;
  /** Texto do botão que confirma (cada uso diz o que acontece depois). */
  confirmLabel: string;
  onCancel(): void;
  /** Recebe o arquivo recortado, já no formato do original (JPEG ou PNG). */
  onConfirm(file: File): void;
}

/** Fração da imagem que a moldura inicial ocupa, antes de o usuário mexer. */
const INITIAL_FRAME_PERCENT = 90;

/**
 * Moldura inicial centralizada. Sem proporção (Livre) ocupa quase tudo; com proporção, a maior moldura que cabe
 * nessa proporção.
 */
function initialFrame(ratio: number | undefined, width: number, height: number): PercentCrop {
  if (ratio === undefined) return freeFrame();
  return centerCrop(makeAspectCrop({ unit: '%', width: INITIAL_FRAME_PERCENT }, ratio, width, height), width, height);
}

/** Free frame, centred. Also the frame before the image has loaded, so the crop state is never undefined. */
function freeFrame(): PercentCrop {
  const inset = (100 - INITIAL_FRAME_PERCENT) / 2;
  return { unit: '%', x: inset, y: inset, width: INITIAL_FRAME_PERCENT, height: INITIAL_FRAME_PERCENT };
}

/**
 * Recorte com moldura ajustável (alças nos cantos e nas bordas) e presets de proporção. Pura apresentação e estado
 * do recorte: a conversão para o arquivo fica em cropImageToFile. Não tem portal nem voltar próprio: quem monta
 * decide o que Esc e o voltar do navegador fazem.
 */
export function ImageCropper({ src, name, mime, confirmLabel, onCancel, onConfirm }: ImageCropperProps) {
  const { t } = useTranslation('files');
  const image = useRef<HTMLImageElement>(null);
  const [preset, setPreset] = useState<CropPresetId>('free');
  const [crop, setCrop] = useState<PercentCrop>(freeFrame);
  /** Mesma moldura em pixels da imagem exibida; é ela que vira o recorte. */
  const [pixels, setPixels] = useState<PixelCrop | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  function applyFrame(frame: PercentCrop, width: number, height: number) {
    setCrop(frame);
    setPixels(convertToPixelCrop(frame, width, height));
  }

  function onImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const { width, height } = event.currentTarget;
    applyFrame(initialFrame(presetRatio(preset), width, height), width, height);
  }

  function choosePreset(id: CropPresetId) {
    setPreset(id);
    const img = image.current;
    if (img === null) return;
    applyFrame(initialFrame(presetRatio(id), img.width, img.height), img.width, img.height);
  }

  // Free crop: the prop is left out entirely (exactOptionalPropertyTypes forbids an undefined value).
  const ratio = presetRatio(preset);
  const aspectProps = ratio === undefined ? {} : { aspect: ratio };

  async function confirm() {
    const img = image.current;
    if (img === null || pixels === null || busy) return;
    const rect = sourceRect(
      { x: pixels.x, y: pixels.y, width: pixels.width, height: pixels.height },
      { width: img.width, height: img.height },
      { width: img.naturalWidth, height: img.naturalHeight },
    );
    if (rect.width < 1 || rect.height < 1) return;
    setBusy(true);
    setFailed(false);
    try {
      onConfirm(await cropImageToFile(img, rect, { name, mime }));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-slot="image-cropper" className="flex min-h-0 flex-1 flex-col text-white">
      <div className="flex items-center gap-2 pt-[calc(env(safe-area-inset-top,0px)+8px)] pr-2 pb-2 pl-4">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{t('cropper.title')}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/15"
          aria-label={t('cropper.cancel')}
          onClick={onCancel}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
        <ReactCrop
          crop={crop}
          {...aspectProps}
          ariaLabels={{
            cropArea: t('cropper.handles.cropArea'),
            nwDragHandle: t('cropper.handles.nwDragHandle'),
            nDragHandle: t('cropper.handles.nDragHandle'),
            neDragHandle: t('cropper.handles.neDragHandle'),
            eDragHandle: t('cropper.handles.eDragHandle'),
            seDragHandle: t('cropper.handles.seDragHandle'),
            sDragHandle: t('cropper.handles.sDragHandle'),
            swDragHandle: t('cropper.handles.swDragHandle'),
            wDragHandle: t('cropper.handles.wDragHandle'),
          }}
          ruleOfThirds
          keepSelection
          onChange={(pixel, percent) => {
            setCrop(percent);
            setPixels(pixel);
          }}
          className="max-h-full max-w-full"
        >
          <img
            ref={image}
            src={src}
            alt={name}
            draggable={false}
            onLoad={onImageLoad}
            className="block max-h-[60dvh] max-w-full select-none object-contain"
          />
        </ReactCrop>
      </div>

      <div className="flex flex-col gap-2 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
        <div role="group" aria-label={t('cropper.ratio')} className="grid grid-cols-4 gap-1.5">
          {CROP_PRESETS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={preset === option.id}
              onClick={() => choosePreset(option.id)}
              className={cn(
                'h-11 rounded-md border border-white/25 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                preset === option.id ? 'bg-white text-black' : 'text-white hover:bg-white/15',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {failed && (
          <p role="alert" className="text-sm text-white">
            {t('cropper.failed')}
          </p>
        )}
        <Button
          type="button"
          variant="secondary"
          size="wide"
          className="bg-white/15 text-white hover:bg-white/25"
          disabled={busy || pixels === null}
          onClick={() => void confirm()}
        >
          {busy ? t('cropper.cropping') : confirmLabel}
        </Button>
      </div>
    </div>
  );
}
