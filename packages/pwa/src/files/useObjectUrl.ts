import { useEffect, useState } from 'react';

/** `blob:` URL de um Blob enquanto ele existe; revogada ao trocar o Blob ou ao desmontar. Null sem Blob. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);

  return url;
}
