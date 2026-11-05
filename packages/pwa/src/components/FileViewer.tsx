import { useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CircleExclamationPoint, Crop, X } from 'lucide-react';
import { TransformComponent, TransformWrapper } from 'react-zoom-pan-pinch';
import type { FileInfo } from '@nanachi/shared';
import { canShareFiles } from '../files/share.js';
import { downloadBlob, shareOrDownload, shareOrSaveFile } from '../files/save.js';
import { useObjectUrl } from '../files/useObjectUrl.js';
import { describeError } from '../errorMessages.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { canSwipeToDismiss, isDismissDrag, isPointInside, isTapToClose, isZoomed } from './viewerGesture.js';
import { ImageCropper } from './ImageCropper.js';
import { useModalOverlay } from './useModalOverlay.js';

interface FileViewerProps {
  file: FileInfo;
  blob: Blob;
  url: string;
  onClose(): void;
  /** Só existe quando o visualizador foi aberto do chat: recebe o recorte para o composer. */
  onAttachToChat?: ((file: File) => void) | undefined;
}

interface Drag {
  startX: number;
  startY: number;
  dx: number;
  dy: number;
}

/** `view`: a foto com zoom. `crop`: recorte. `result`: o recorte pronto para salvar, compartilhar ou anexar. */
type ViewerMode = 'view' | 'crop' | 'result';

const MAX_SCALE = 4;
/** Zoom de cada toque duplo (o modo `toggle` do zoom: vai até o limite e o próximo toque volta ao tamanho inicial). */
const DOUBLE_TAP_STEP = 1.5;

/**
 * Imagem em tela cheia, fora do chat (portal no body, acima de tudo). Pinça e arrasto ampliam e movem a imagem;
 * toque duplo amplia no ponto tocado e volta. Na escala de repouso, arrastar para baixo, tocar fora da imagem, X,
 * Esc e o voltar do navegador fecham. Ampliada, o arrasto é pan e nada fecha por gesto.
 * Fundo preto nos dois temas: a foto é o que importa, como no visualizador de fotos do iOS.
 */
export function FileViewer({ file, blob, url, onClose, onAttachToChat }: FileViewerProps) {
  const { t } = useTranslation('files');
  const [mode, setMode] = useState<ViewerMode>('view');
  const [scale, setScale] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cropped, setCropped] = useState<File | null>(null);
  const croppedUrl = useObjectUrl(cropped);
  const pointers = useRef(new Set<number>());
  const imageRef = useRef<HTMLImageElement>(null);
  /** Maior deslocamento do ponteiro desde o primeiro toque: se passou do limite, o clique seguinte não fecha. */
  const travel = useRef(0);
  const zoomed = isZoomed(scale);
  const shareable = canShareFiles(navigator, new File([blob], file.name, { type: blob.type }));
  const dragging = drag !== null && drag.dy > 0;
  useModalOverlay(onClose);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    pointers.current.add(event.pointerId);
    travel.current = 0;
    const swipeAllowed = canSwipeToDismiss(scale, pointers.current.size);
    setDrag(swipeAllowed ? { startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 } : null);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag === null) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    travel.current = Math.max(travel.current, Math.hypot(dx, dy));
    if (!canSwipeToDismiss(scale, pointers.current.size)) {
      setDrag(null);
      return;
    }
    setDrag({ ...drag, dx, dy: Math.max(0, dy) });
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0 && drag !== null && canSwipeToDismiss(scale, 1) && isDismissDrag(drag.dx, drag.dy)) {
      onClose();
      return;
    }
    setDrag(null);
  }

  /**
   * Toque fora da foto fecha na escala de repouso. A foto não recebe o ponteiro (a biblioteca de zoom desliga
   * pointer-events na imagem), então o alvo do clique é o contêiner: a posição é que decide.
   */
  function onStageClick(event: MouseEvent<HTMLDivElement>) {
    const box = imageRef.current?.getBoundingClientRect();
    if (box !== undefined && isPointInside(box, event.clientX, event.clientY)) return;
    if (isTapToClose(scale, travel.current)) onClose();
  }

  function acceptCrop(result: File) {
    setError(null);
    setCropped(result);
    setMode('result');
  }

  const viewStage = (
    <div
      data-slot="file-viewer-stage"
      className="flex min-h-0 flex-1 touch-none select-none items-center justify-center"
      onClick={onStageClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      // A native drag (a text selection left by the double tap, or the image) cancels the pointer stream, so the
      // swipe-to-close drag never reaches us. The stage's own gestures replace it.
      onDragStart={(event) => event.preventDefault()}
    >
      {/* Zoom e pan da biblioteca; o arrasto para baixo é nosso e só vale na escala de repouso (ver panning). */}
      <TransformWrapper
        initialScale={1}
        minScale={1}
        maxScale={MAX_SCALE}
        limitToBounds
        doubleClick={{ mode: 'toggle', step: DOUBLE_TAP_STEP }}
        panning={{ disabled: !zoomed }}
        onTransform={(_ref, state) => setScale(state.scale)}
      >
        <TransformComponent wrapperClass="h-full w-full" contentClass="h-full w-full flex items-center justify-center">
          <img
            ref={imageRef}
            data-slot="file-viewer-image"
            className={cn(
              'block max-h-full max-w-full object-contain select-none [-webkit-touch-callout:none]',
              'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              dragging && 'transition-none',
            )}
            src={url}
            alt={file.name}
            style={dragging ? { transform: `translateY(${drag.dy}px)` } : undefined}
            draggable={false}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>
  );

  const resultStage = (
    <div className="flex min-h-0 flex-1 items-center justify-center p-3">
      {croppedUrl !== null && (
        <img
          data-slot="file-viewer-result"
          className="block max-h-full max-w-full object-contain select-none"
          src={croppedUrl}
          alt={cropped?.name ?? file.name}
          draggable={false}
        />
      )}
    </div>
  );

  const body =
    mode === 'crop' ? (
      <ImageCropper
        src={url}
        name={file.name}
        mime={blob.type}
        confirmLabel={t('viewer.viewCrop')}
        onCancel={() => setMode('view')}
        onConfirm={acceptCrop}
      />
    ) : (
      <>
        <div className="flex items-center gap-2 pt-[calc(env(safe-area-inset-top,0px)+8px)] pr-2 pb-2 pl-4">
          <span data-slot="file-viewer-name" className="min-w-0 flex-1 truncate text-[15px]">
            {mode === 'result' && cropped !== null ? cropped.name : file.name}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15"
            aria-label={mode === 'view' ? t('viewer.crop') : t('viewer.cropAgain')}
            onClick={() => setMode('crop')}
          >
            <Crop aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-white hover:bg-white/15"
            aria-label={t('viewer.close')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        {mode === 'view' ? viewStage : resultStage}

        {mode === 'view' ? (
          <div className="flex flex-col gap-2 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            {error !== null && <ViewerError error={error} />}
            {shareable ? (
              <Button
                type="button"
                variant="secondary"
                size="wide"
                className="bg-white/15 text-white hover:bg-white/25"
                onClick={() => {
                  setError(null);
                  shareOrDownload(blob, file).catch(setError);
                }}
              >
                {t('viewer.share')}
              </Button>
            ) : (
              <Button asChild variant="secondary" size="wide" className="bg-white/15 text-white hover:bg-white/25">
                <a href={url} download={file.name}>
                  {t('viewer.save')}
                </a>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            {error !== null && <ViewerError error={error} />}
            {cropped !== null && onAttachToChat !== undefined && (
              <Button
                type="button"
                size="wide"
                className="bg-white text-black hover:bg-white/90"
                onClick={() => {
                  onAttachToChat(cropped);
                  onClose();
                }}
              >
                {t('viewer.attachToChat')}
              </Button>
            )}
            <div className="flex gap-2">
              {cropped !== null && canShareFiles(navigator, cropped) && (
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1 bg-white/15 text-white hover:bg-white/25"
                  onClick={() => {
                    setError(null);
                    shareOrSaveFile(cropped).catch(setError);
                  }}
                >
                  {t('viewer.share')}
                </Button>
              )}
              {cropped !== null && (
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1 bg-white/15 text-white hover:bg-white/25"
                  onClick={() => downloadBlob(cropped, cropped.name)}
                >
                  {t('viewer.save')}
                </Button>
              )}
            </div>
          </div>
        )}
      </>
    );

  return createPortal(
    <div
      data-slot="file-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="fixed inset-0 z-50 flex flex-col bg-black text-white"
    >
      {body}
    </div>,
    document.body,
  );
}

function ViewerError({ error }: { error: unknown }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-white">
      <CircleExclamationPoint className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{describeError(error)}</span>
    </p>
  );
}
