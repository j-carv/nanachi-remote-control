import type { SessionStatus } from '@nanachi/shared';

/** Sessão parada ou com erro: o histórico fica só leitura até "Retomar". */
export function isResumable(status: SessionStatus): boolean {
  return status === 'stopped' || status === 'error';
}

/** Input só em `idle` (pronto) e `running` (dá para digitar a próxima enquanto o agente trabalha). */
export function isInputEnabled(status: SessionStatus): boolean {
  return status === 'idle' || status === 'running';
}

/**
 * Pode mandar um prompt agora: sessão pronta, ou parada/com erro (o daemon retoma antes do turno).
 * `running` fica de fora: o daemon responde session_busy.
 */
export function acceptsPrompt(status: SessionStatus): boolean {
  return status === 'idle' || isResumable(status);
}
