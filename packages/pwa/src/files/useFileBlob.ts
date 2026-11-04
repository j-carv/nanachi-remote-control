import { useEffect, useState } from 'react';
import type { FileInfo } from '@nanachi/shared';
import type { ApiClient } from '../api.js';

export interface FileBlobState {
  blob: Blob | null;
  /** `blob:` URL para `<img src>`; revogada ao desmontar ou trocar de arquivo. */
  url: string | null;
  error: unknown;
}

const EMPTY: FileBlobState = { blob: null, url: null, error: null };

/** Baixa o arquivo com o Bearer do app quando `enabled` (imagens, para miniatura). */
export function useFileBlob(api: ApiClient, file: FileInfo, enabled: boolean): FileBlobState {
  const [state, setState] = useState<FileBlobState>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let objectUrl: string | null = null;
    api.fetchFileBlob(file.fileId, file.mime).then(
      (blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ blob, url: objectUrl, error: null });
      },
      (error: unknown) => {
        if (active) setState({ blob: null, url: null, error });
      },
    );
    return () => {
      active = false;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [api, file.fileId, file.mime, enabled]);

  return state;
}
