import { useEffect, useState } from 'react';
import type { TranscriptionStatus } from '@nanachi/shared';
import type { ApiClient } from '../api.js';

/** Readiness belongs to the selected provider, independently of the local installer. */
export function useTranscriptionStatus(api: ApiClient, enabled = true) {
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    setStatus(null);
    setUnreachable(false);
    if (!enabled) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const next = await api.transcriptionStatus();
        if (active) { setStatus(next); setUnreachable(false); }
      } catch {
        if (active) { setStatus(null); setUnreachable(true); }
      } finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, enabled]);
  return { status, unreachable };
}
