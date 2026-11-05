import { useTranslation } from 'react-i18next';
import { Crop, X } from 'lucide-react';
import type { DraftAttachment } from './useAttachmentDrafts.js';
import { formatBytes } from '../files/format.js';

interface AttachmentDraftsProps {
  drafts: readonly DraftAttachment[];
  onRemove(id: string): void;
  /** Abre o recorte de uma imagem da prévia; o resultado troca o anexo. */
  onCrop(id: string): void;
}

/**
 * Prévia dos anexos antes de enviar: miniatura para imagem, nome para o resto; cada um sai com ×. Imagem também
 * tem recorte (canto inferior esquerdo).
 */
export function AttachmentDrafts({ drafts, onRemove, onCrop }: AttachmentDraftsProps) {
  const { t } = useTranslation('chat');
  if (drafts.length === 0) return null;
  return (
    // Padding on all sides keeps the remove and crop buttons, which overhang each item, inside the scroll box.
    <ul data-slot="draft-list" aria-label={t('attachments.label')} className="-mx-2 flex gap-2 overflow-x-auto px-2 pt-2 pb-2">
      {drafts.map(({ id, file, previewUrl }) => (
        <li key={id} className="relative shrink-0">
          {previewUrl !== null ? (
            <div className="size-16 overflow-hidden rounded-md bg-muted">
              <img data-slot="draft-thumb" className="size-full object-cover" src={previewUrl} alt={file.name} />
            </div>
          ) : (
            <div className="flex h-16 w-40 flex-col justify-center gap-0.5 overflow-hidden rounded-md bg-muted py-1.5 pr-8 pl-2.5">
              <span className="truncate text-sm">{file.name}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            </div>
          )}
          {previewUrl !== null && (
            <button
              type="button"
              data-slot="draft-crop"
              aria-label={t('attachments.crop', { name: file.name })}
              onClick={() => onCrop(id)}
              className="absolute -bottom-2 -left-2 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex size-6 items-center justify-center rounded-full bg-foreground/75 text-background">
                <Crop className="size-3.5" aria-hidden="true" />
              </span>
            </button>
          )}
          <button
            type="button"
            aria-label={t('attachments.remove', { name: file.name })}
            onClick={() => onRemove(id)}
            className="absolute -top-2 -right-2 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-foreground/75 text-background">
              <X className="size-3.5" aria-hidden="true" />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
