import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import type { ControlError } from '../common/control-api.js';
import { DaemonApiError } from './daemon-api.js';
import { PairingError } from './pairing.js';
import { RootsConfigError } from './roots-config.js';

/** A failure the renderer can show as is: in Desktop's language, no internals, never a token. */
export function controlFailure(code: ControlError['code'], message: string): ControlError {
  return { ok: false, code, message };
}

function rejectedMessage(apiCode: string | null): string {
  switch (apiCode) {
    case 'accounts_unsupported':
      return t('main.control.rejected.accountsUnsupported');
    case 'account_in_use':
      return t('main.control.rejected.accountInUse');
    case 'too_many_accounts':
      return t('main.control.rejected.tooManyAccounts');
    case 'not_found':
      return t('main.control.rejected.notFound');
    default:
      return t('main.control.rejected.refused');
  }
}

function daemonFailure(error: DaemonApiError): ControlError {
  switch (error.kind) {
    case 'unavailable':
      return controlFailure('daemon_unavailable', t('main.control.daemon.unavailable'));
    case 'not_paired':
      return controlFailure('not_paired', t('main.control.daemon.notPaired', { detail: error.message }));
    case 'unauthorized':
      return controlFailure('unauthorized', t('main.control.daemon.unauthorized'));
    case 'forbidden':
      return controlFailure('unauthorized', t('main.control.daemon.forbidden'));
    case 'rejected':
      return controlFailure('invalid_input', rejectedMessage(error.apiCode));
    case 'not_found':
      return controlFailure('unknown', t('main.control.daemon.notFound'));
    case 'busy':
      return controlFailure('unknown', t('main.control.daemon.busy'));
    case 'server':
      return controlFailure('unknown', t('main.control.daemon.server', { status: error.status ?? '?' }));
    case 'bad_response':
      return controlFailure('unknown', t('main.control.daemon.badResponse'));
  }
}

function pairingFailure(error: PairingError): ControlError {
  const message = t('main.control.pairingFailed', { detail: error.message });
  if (error.kind === 'network') return controlFailure('daemon_unavailable', message);
  if (error.kind === 'rejected') return controlFailure('not_paired', message);
  return controlFailure('unknown', message);
}

/** Maps whatever a handler caught to a `ControlError`. Messages that already fit the user (`RootsConfigError`) are kept. */
export function toControlError(error: unknown): ControlError {
  if (error instanceof DaemonApiError) return daemonFailure(error);
  if (error instanceof RootsConfigError) return controlFailure(error.code, error.message);
  if (error instanceof PairingError) return pairingFailure(error);
  return controlFailure('unknown', t('main.control.somethingWrong', { detail: messageOf(error) }));
}
