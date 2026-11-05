import type { ControlError } from '../../common/control-api.js';

const TITLES: Record<ControlError['code'], string> = {
  daemon_unavailable: 'O daemon não está respondendo',
  not_paired: 'Este app ainda não está pareado com o daemon',
  unauthorized: 'O daemon recusou o acesso',
  invalid_input: 'Não foi possível usar esses dados',
  io: 'Falha ao ler ou gravar arquivos',
  not_own_daemon: 'Este daemon não foi iniciado pelo Nanachi',
  unknown: 'Algo deu errado',
};

/** Short headline for an error state; the Portuguese `message` from main goes under it. */
export function errorTitle(code: ControlError['code']): string {
  return TITLES[code];
}

/**
 * Attached to a daemon Desktop did not start, the daemon may not know this app: devices and accounts answer these codes.
 * They are expected there, so the screen explains instead of alarming.
 */
export function isCalmError(code: ControlError['code']): boolean {
  return code === 'not_paired' || code === 'unauthorized' || code === 'not_own_daemon';
}

export function calmErrorHint(): string {
  return 'Isso é esperado quando o Nanachi está conectado a um daemon que ele não iniciou: o resto do painel continua funcionando.';
}

/** An IPC call that rejects (instead of returning a `ControlError`) is shown as an unknown error, never as raw text. */
export function toControlError(_error: unknown): ControlError {
  return { ok: false, code: 'unknown', message: 'Não foi possível falar com o Nanachi. Tente de novo.' };
}
