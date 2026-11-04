import { useState } from 'react';
import type { FileInfo } from '@nanachi/shared';
import { canShareFiles } from '../files/share.js';
import { shareOrDownload } from '../files/save.js';
import { describeError } from '../errorMessages.js';

interface FileViewerProps {
  file: FileInfo;
  blob: Blob;
  url: string;
  onClose(): void;
}

/** Imagem em tela cheia. Compartilhar quando o navegador deixa; senão, link para salvar. */
export function FileViewer({ file, blob, url, onClose }: FileViewerProps) {
  const [error, setError] = useState<unknown>(null);
  const shareable = canShareFiles(navigator, new File([blob], file.name, { type: blob.type }));

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose}>
      <div className="viewer-bar" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
          ×
        </button>
        <span className="viewer-name">{file.name}</span>
        {shareable ? (
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setError(null);
              shareOrDownload(blob, file).catch(setError);
            }}
          >
            Compartilhar
          </button>
        ) : (
          <a className="button primary" href={url} download={file.name}>
            Salvar
          </a>
        )}
      </div>
      {error !== null && (
        <p className="viewer-error" role="alert">
          {describeError(error)}
        </p>
      )}
      <img
        className="viewer-image"
        src={url}
        alt={file.name}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
