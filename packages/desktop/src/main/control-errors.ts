import { messageOf } from '../common/message.js';
import type { ControlError } from '../common/control-api.js';
import { DaemonApiError } from './daemon-api.js';
import { PairingError } from './pairing.js';
import { RootsConfigError } from './roots-config.js';

/** A failure the renderer can show as is: Portuguese, no internals, never a token. */
export function controlFailure(code: ControlError['code'], message: string): ControlError {
  return { ok: false, code, message };
}

function rejectedMessage(apiCode: string | null): string {
  switch (apiCode) {
    case 'accounts_unsupported':
      return 'Este agente não tem contas extras.';
    case 'account_in_use':
      return 'Há uma sessão usando esta conta.';
    case 'too_many_accounts':
      return 'O limite de contas deste agente foi atingido.';
    case 'not_found':
      return 'O agente ou a conta não foi encontrado.';
    default:
      return 'O daemon recusou o pedido.';
  }
}

function daemonFailure(error: DaemonApiError): ControlError {
  switch (error.kind) {
    case 'unavailable':
      return controlFailure('daemon_unavailable', 'Não foi possível falar com o daemon do Nanachi. Ele pode estar parado ou ainda iniciando.');
    case 'not_paired':
      return controlFailure('not_paired', `Não foi possível parear o Nanachi Desktop com o daemon: ${error.message}`);
    case 'unauthorized':
      return controlFailure('unauthorized', 'O daemon recusou o acesso do Nanachi Desktop; o dispositivo pode ter sido revogado. Tente de novo.');
    case 'forbidden':
      return controlFailure(
        'unauthorized',
        'O daemon só aceita acessos pelo Tailscale (allowedTailscaleLogins no config.json), então o Nanachi Desktop não consegue consultá-lo. ' +
          'Deixe essa lista vazia no config.json da pasta de dados do Desktop.',
      );
    case 'rejected':
      return controlFailure('invalid_input', rejectedMessage(error.apiCode));
    case 'not_found':
      return controlFailure('unknown', 'O daemon não encontrou o que foi pedido.');
    case 'busy':
      return controlFailure('unknown', 'O daemon pediu calma: houve tentativas demais seguidas. Aguarde um instante e tente de novo.');
    case 'server':
      return controlFailure('unknown', `O daemon respondeu com erro (HTTP ${error.status ?? '?'}). Veja a aba Logs.`);
    case 'bad_response':
      return controlFailure('unknown', 'O daemon respondeu algo que o Nanachi não entendeu. Ele pode ser de outra versão.');
  }
}

function pairingFailure(error: PairingError): ControlError {
  const message = `Não foi possível concluir o pareamento: ${error.message}`;
  if (error.kind === 'network') return controlFailure('daemon_unavailable', message);
  if (error.kind === 'rejected') return controlFailure('not_paired', message);
  return controlFailure('unknown', message);
}

/** Maps whatever a handler caught to a `ControlError`. Messages that already fit the user (`RootsConfigError`) are kept. */
export function toControlError(error: unknown): ControlError {
  if (error instanceof DaemonApiError) return daemonFailure(error);
  if (error instanceof RootsConfigError) return controlFailure(error.code, error.message);
  if (error instanceof PairingError) return pairingFailure(error);
  return controlFailure('unknown', `Algo deu errado: ${messageOf(error)}`);
}
