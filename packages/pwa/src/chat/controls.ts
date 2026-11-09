import type { SessionStatus } from '@nanachi/shared';

/** Sessão parada ou com erro: o histórico fica só leitura até "Retomar". */
export function isResumable(status: SessionStatus): boolean {
  return status === 'stopped' || status === 'error';
}

export function queuesPrompt(status: SessionStatus): boolean {
  return status === 'running' || status === 'awaiting_permission';
}

/** The composer is available during active work and permission requests. */
export function isInputEnabled(status: SessionStatus): boolean {
  return status === 'idle' || queuesPrompt(status);
}

/**
 * Pode mandar um prompt agora: sessão pronta, ou parada/com erro (o daemon retoma antes do turno).
 * `running` fica de fora: o daemon responde session_busy.
 */
export function acceptsPrompt(status: SessionStatus): boolean {
  return status === 'idle' || isResumable(status);
}

/**
 * Whether a config option can be changed now (`set_config`). The daemon applies the change to a live agent that has
 * opened its session: a stopped or failed session, or one still starting, is refused. A running turn is not.
 */
export function acceptsConfigChange(status: SessionStatus): boolean {
  return status === 'idle' || status === 'running' || status === 'awaiting_permission';
}
