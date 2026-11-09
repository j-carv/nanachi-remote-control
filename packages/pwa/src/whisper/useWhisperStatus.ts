import { useEffect, useState } from 'react';
import type { WhisperStatus } from '@nanachi/shared';
import type { ApiClient } from '../api.js';

export function useWhisperStatus(api: ApiClient, enabled = true, quick = false) {
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const next = await api.whisperStatus();
        if (active) {
          setStatus(next);
          setUnreachable(false);
        }
      } catch {
        if (active) setUnreachable(true);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), quick ? 1_000 : 5_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [api, enabled, quick]);
  return { status, setStatus, unreachable };
}
