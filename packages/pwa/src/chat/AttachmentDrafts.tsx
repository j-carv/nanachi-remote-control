import type { DraftAttachment } from './useAttachmentDrafts.js';
import { formatBytes } from '../files/format.js';

interface AttachmentDraftsProps {
  drafts: readonly DraftAttachment[];
  onRemove(id: string): void;
}

/** Prévia dos anexos antes de enviar: miniatura para imagem, nome para o resto; cada um sai com ×. */
export function AttachmentDrafts({ drafts, onRemove }: AttachmentDraftsProps) {
  if (drafts.length === 0) return null;
  return (
    <ul className="draft-list" aria-label="Anexos">
      {drafts.map(({ id, file, previewUrl }) => (
        <li key={id} className={previewUrl === null ? 'draft-item draft-item-file' : 'draft-item'}>
          {previewUrl !== null ? (
            <img className="draft-thumb" src={previewUrl} alt={file.name} />
          ) : (
            <span className="draft-file">
              <span className="draft-name">{file.name}</span>
              <span className="muted small">{formatBytes(file.size)}</span>
            </span>
          )}
          <button
            type="button"
            className="draft-remove"
            aria-label={`Remover ${file.name}`}
            onClick={() => onRemove(id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
