import { useCallback } from 'react';
import { runReported } from '../lib/guard.js';
import { useToast } from '../ui/Toast.js';

/** `const run = useReported(); run(() => api.folders.reveal(path), t('folders.revealFailed'))`: a failure becomes a toast. */
export function useReported(): (run: () => Promise<unknown>, failure: string) => void {
  const toast = useToast();
  return useCallback((run, failure) => runReported(run, () => toast({ tone: 'error', message: failure })), [toast]);
}
