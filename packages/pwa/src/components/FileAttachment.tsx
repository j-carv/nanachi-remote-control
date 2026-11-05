import { useState } from 'react';
import type { FileInfo } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { Button } from '@/components/ui/button';
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
    <figure data-slot="file-attachment" className="m-0 flex max-w-full flex-col gap-1.5">
      {isInlineImageMime(file.mime) ? (
        <ImageThumb api={api} file={file} />
      ) : (
        <FileCard api={api} file={file} />
      )}
      {caption !== undefined && caption !== null && caption !== '' && (
        <figcaption data-slot="file-caption" className="text-sm whitespace-pre-wrap text-muted-foreground">
          {caption}
        </figcaption>
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
    <div data-slot="file-card" className="flex max-w-full flex-wrap items-center gap-2.5 rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 flex-1 basis-[140px] flex-col">
        <span data-slot="file-name" className="font-semibold [overflow-wrap:anywhere]">{file.name}</span>
        <span data-slot="file-size" className="text-sm text-muted-foreground">{formatBytes(file.size)}</span>
      </div>
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        {busy ? 'Baixando…' : 'Baixar'}
      </Button>
      {error !== null && <p className="w-full text-sm text-destructive [overflow-wrap:anywhere]">{describeError(error)}</p>}
    </div>
  );
}
