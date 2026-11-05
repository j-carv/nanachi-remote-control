import { useEffect, useRef, useState } from 'react';
import { isImageMime } from '../files/format.js';
import { acceptedCount } from './attachments.js';

/** Anexo escolhido no input, ainda não enviado. `previewUrl` só existe para imagens. */
export interface DraftAttachment {
  id: string;
  file: File;
  previewUrl: string | null;
}

function createDraft(id: string, file: File): DraftAttachment {
  return { id, file, previewUrl: isImageMime(file.type) ? URL.createObjectURL(file) : null };
}

function releaseDraft(draft: DraftAttachment): void {
  if (draft.previewUrl !== null) URL.revokeObjectURL(draft.previewUrl);
}

/**
 * Prévia dos anexos antes de enviar. Cada miniatura é um `blob:` que é revogado ao remover,
 * ao limpar (após enviar) e ao desmontar a tela.
 */
export function useAttachmentDrafts() {
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  const latest = useRef<DraftAttachment[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    latest.current = drafts;
  }, [drafts]);

  useEffect(() => {
    const current = latest;
    return () => current.current.forEach(releaseDraft);
  }, []);

  return {
    drafts,
    /** Adiciona até o limite; devolve quantos ficaram de fora. */
    add(files: readonly File[]): number {
      const room = acceptedCount(drafts.length, files.length);
      const created = files.slice(0, room).map((file) => {
        nextId.current += 1;
        return createDraft(`draft-${nextId.current}`, file);
      });
      setDrafts([...drafts, ...created]);
      return files.length - room;
    },
    /** Troca o arquivo de um anexo (recorte) e mantém a posição na lista. A prévia antiga é liberada. */
    replace(id: string, file: File): void {
      const target = drafts.find((draft) => draft.id === id);
      if (target === undefined) return;
      releaseDraft(target);
      setDrafts(drafts.map((draft) => (draft.id === id ? createDraft(id, file) : draft)));
    },
    remove(id: string): void {
      const target = drafts.find((draft) => draft.id === id);
      if (target !== undefined) releaseDraft(target);
      setDrafts(drafts.filter((draft) => draft.id !== id));
    },
    clear(): void {
      drafts.forEach(releaseDraft);
      setDrafts([]);
    },
  };
}
