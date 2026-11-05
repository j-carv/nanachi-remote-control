import { createPortal } from 'react-dom';
import { useModalOverlay } from './useModalOverlay.js';
import { ImageCropper } from './ImageCropper.js';

interface ImageCropDialogProps {
  src: string;
  name: string;
  mime: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(file: File): void;
}

/**
 * Recorte em tela cheia, como sobreposição própria (portal, Esc e voltar fecham). Usado pelo composer, onde o
 * recorte troca um anexo antes do envio. O visualizador de imagens monta ImageCropper direto, dentro do seu
 * próprio portal, para não ter duas sobreposições empilhadas.
 */
export function ImageCropDialog(props: ImageCropDialogProps) {
  useModalOverlay(props.onCancel);

  return createPortal(
    <div
      data-slot="image-crop-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Recortar imagem"
      className="fixed inset-0 z-50 flex flex-col bg-black"
    >
      <ImageCropper {...props} />
    </div>,
    document.body,
  );
}
