import type { DaemonStatus } from './types.js';

/** First tray menu line and tooltip. The wording is part of the contract (Portuguese UI). */
export function statusLabel(status: Pick<DaemonStatus, 'state'>): string {
  switch (status.state) {
    case 'starting':
      return 'Nanachi · iniciando';
    case 'running':
      return 'Nanachi · rodando';
    case 'attached':
      return 'Nanachi · conectado ao daemon existente';
    case 'stopped':
      return 'Nanachi · parado';
    case 'error':
      return 'Nanachi · erro';
  }
}
