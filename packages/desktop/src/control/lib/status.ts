import type { DaemonStatus, TailscaleStatus } from '../../common/types.js';

/** `muted` is the neutral grey; the others are the status tokens of docs/DESIGN.md. */
export type Tone = 'success' | 'running' | 'attention' | 'destructive' | 'muted';

export interface StatusSummary {
  /** One word, for the title bar and badges. */
  word: string;
  tone: Tone;
  /** Transitional state: the dot pulses (stops under reduced motion). */
  pulse: boolean;
  /** One short line for the overview. */
  detail: string;
}

export function daemonSummary(status: DaemonStatus): StatusSummary {
  switch (status.state) {
    case 'running':
      return {
        word: 'Rodando',
        tone: status.restricted ? 'attention' : 'success',
        pulse: false,
        detail: 'Daemon iniciado pelo Nanachi',
      };
    case 'attached':
      return {
        word: 'Conectado',
        tone: status.restricted ? 'attention' : 'running',
        pulse: false,
        detail: 'Daemon que já estava rodando; o Nanachi só se conecta a ele',
      };
    case 'starting':
      return { word: 'Iniciando', tone: 'attention', pulse: true, detail: 'Esperando o daemon responder' };
    case 'stopped':
      return { word: 'Parado', tone: 'muted', pulse: false, detail: 'O daemon não está rodando' };
    case 'error':
      return { word: 'Erro', tone: 'destructive', pulse: false, detail: status.message ?? 'O daemon não conseguiu iniciar' };
  }
}

export function tailscaleSummary(status: TailscaleStatus): StatusSummary {
  switch (status.state) {
    case 'off':
      return { word: 'Desligado', tone: 'muted', pulse: false, detail: 'O nó do Tailscale embutido não está ligado' };
    case 'starting':
      return { word: 'Iniciando', tone: 'attention', pulse: true, detail: 'Conectando à sua tailnet' };
    case 'needs_login':
      return { word: 'Precisa entrar', tone: 'attention', pulse: false, detail: 'Entre com a sua conta para continuar' };
    case 'running':
      return { word: 'Ligado', tone: 'success', pulse: false, detail: status.dnsName };
    case 'error':
      return { word: 'Erro', tone: 'destructive', pulse: false, detail: status.message };
  }
}
