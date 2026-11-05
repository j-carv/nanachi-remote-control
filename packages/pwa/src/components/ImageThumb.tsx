import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileInfo } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { useFileBlob } from '../files/useFileBlob.js';
import { useChatAttach } from '../chat/attachContext.js';
import { FileViewer } from './FileViewer.js';

interface ImageThumbProps {
  api: ApiClient;
  file: FileInfo;
}

/**
 * Miniatura de imagem do PC (baixada com o Bearer do app). Toque abre o visualizador em tela cheia. Dentro do chat,
 * o visualizador ganha "Anexar ao chat" para o recorte; fora dele, a ação some.
 */
export function ImageThumb({ api, file }: ImageThumbProps) {
  const { t } = useTranslation('files');
  const [open, setOpen] = useState(false);
  const loaded = useFileBlob(api, file, true);
  const attachToChat = useChatAttach();

  if (loaded.error !== null) {
    return <p className="text-sm text-muted-foreground">{describeError(loaded.error)}</p>;
  }
  if (loaded.url === null || loaded.blob === null) {
    return (
      <div
        role="img"
        aria-label={t('thumb.loading')}
        className="aspect-[4/3] w-[min(240px,100%)] animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
      />
    );
  }

  return (
    <>
      <button
        type="button"
        data-slot="file-thumb"
        aria-label={t('thumb.open', { name: file.name })}
        onClick={() => setOpen(true)}
        className="block aspect-[4/3] w-[min(240px,100%)] cursor-zoom-in overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img src={loaded.url} alt={file.name} className="size-full object-cover" />
      </button>
      {open && (
        <FileViewer
          file={file}
          blob={loaded.blob}
          url={loaded.url}
          onClose={() => setOpen(false)}
          onAttachToChat={attachToChat ?? undefined}
        />
      )}
    </>
  );
}
