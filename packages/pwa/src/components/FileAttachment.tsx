import { useState } from 'react';
import type { FileInfo } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { describeError } from '../errorMessages.js';
import { shareOrDownload } from '../files/save.js';
import { isInlineImageMime } from '../files/blobType.js';
import { formatBytes } from '../files/format.js';
import { ImageThumb } from './ImageThumb.js';

interface FileAttachmentProps {
  api: ApiClient;
  file: FileInfo;
  caption?: string | null;
}

/** Arquivo trocado com o celular: miniatura para imagem, cartão com nome e tamanho para o resto. */
export function FileAttachment({ api, file, caption }: FileAttachmentProps) {
  return (
    <figure className="file-attachment">
      {isInlineImageMime(file.mime) ? (
        <ImageThumb api={api} file={file} />
      ) : (
        <FileCard api={api} file={file} />
      )}
      {caption !== undefined && caption !== null && caption !== '' && (
        <figcaption className="file-caption pre-wrap">{caption}</figcaption>
      )}
    </figure>
  );
}

function FileCard({ api, file }: { api: ApiClient; file: FileInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      await shareOrDownload(await api.fetchFileBlob(file.fileId, file.mime), file);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="file-card">
      <div className="file-card-text">
        <span className="file-name">{file.name}</span>
        <span className="muted small">{formatBytes(file.size)}</span>
      </div>
      <button type="button" className="button secondary" disabled={busy} onClick={() => void download()}>
        {busy ? 'Baixando…' : 'Baixar'}
      </button>
      {error !== null && <p className="chat-error">{describeError(error)}</p>}
    </div>
  );
}
