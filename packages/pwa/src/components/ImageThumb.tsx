import { useState } from 'react';
import type { FileInfo } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { useFileBlob } from '../files/useFileBlob.js';
import { FileViewer } from './FileViewer.js';

interface ImageThumbProps {
  api: ApiClient;
  file: FileInfo;
}

/** Miniatura de imagem do PC (baixada com o Bearer do app). Toque abre o visualizador em tela cheia. */
export function ImageThumb({ api, file }: ImageThumbProps) {
  const [open, setOpen] = useState(false);
  const loaded = useFileBlob(api, file, true);

  if (loaded.error !== null) {
    return <p className="muted small">{describeError(loaded.error)}</p>;
  }
  if (loaded.url === null || loaded.blob === null) {
    return <div className="file-thumb file-thumb-loading" aria-label="Carregando imagem" />;
  }

  return (
    <>
      <button type="button" className="file-thumb" aria-label={`Abrir ${file.name}`} onClick={() => setOpen(true)}>
        <img src={loaded.url} alt={file.name} />
      </button>
      {open && (
        <FileViewer file={file} blob={loaded.blob} url={loaded.url} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
