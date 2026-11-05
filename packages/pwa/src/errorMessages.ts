import { ApiError } from './api.js';
import { t } from './i18n/index.js';

/** Text for an API error, in the current language: one per `ApiErrorKind`. Anything else is the generic text. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return t(`errors:api.${error.kind}`);
  return t('errors:generic');
}

/** The body code of an API error when it is one of `codes`, else null. Lets the code build a typed translation key. */
function knownCode<Code extends string>(codes: readonly Code[], error: unknown): Code | null {
  if (!(error instanceof ApiError) || error.code === null) return null;
  const received = error.code;
  return codes.find((code) => code === received) ?? null;
}

/**
 * Branch and workspace file codes. The body code wins over the type: `file_too_large` and `binary_file` are not types
 * of their own. An unknown code falls back to `describeError`.
 */
const WORKSPACE_ERROR_CODES = [
  'not_a_git_repo',
  'sessions_running',
  'dirty_worktree',
  'branch_in_use',
  'invalid_branch',
  'branch_exists',
  'branch_not_found',
  'invalid_path',
  'outside_workspace',
  'not_a_file',
  'file_exists',
  'already_exists',
  'file_changed',
  'dir_not_empty',
  'binary_file',
  'file_too_large',
  'too_many_writes',
] as const;

export function describeWorkspaceError(error: unknown): string {
  const code = knownCode(WORKSPACE_ERROR_CODES, error);
  if (code !== null) return t(`errors:workspace.${code}`);
  return describeError(error);
}

/**
 * Text for the usage panel when `fetchSessionUsage` fails. It reads the body code, so it works for codes that
 * share a kind with other errors. Other errors fall back to `describeError`.
 */
export function describeUsageError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'session_not_active') return t('errors:usage.session_not_active');
    if (error.code === 'session_busy') return t('errors:usage.session_busy');
    if (error.code === 'usage_unsupported') return t('errors:usage.usage_unsupported');
    if (error.status === 504) return t('errors:usage.timeout');
  }
  return describeError(error);
}

/** True when the usage error means the session must be resumed first (the panel then shows "Retomar"). */
export function usageNeedsResume(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'session_not_active';
}

/** Text for the "Resets salvos" list when `getUsageResets` fails. Other errors fall back to `describeUsageError`. */
export function describeResetsError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'resets_unsupported') return t('errors:resets.unsupported');
  return describeUsageError(error);
}

/**
 * True when a failed `redeemUsageReset` leaves it unknown whether the reset was spent. Only a 400, 404 or 409 is a
 * refusal before anything ran (invalid target, unknown session, a redeem already running). Everything else may have
 * reached the agent: a 502 or 500 after it started, a 504, a network error, a 2xx that does not match the schema, an
 * error that is not from the API. The panel then says so and reads the usage again, and never sends the redeem again by
 * itself.
 */
export function redeemOutcomeUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status !== 400 && error.status !== 404 && error.status !== 409;
}

/** Text for the usage panel when `redeemUsageReset` fails. See `redeemOutcomeUnknown` for the uncertain cases. */
export function describeRedeemError(error: unknown): string {
  if (redeemOutcomeUnknown(error)) return t('errors:redeem.unconfirmed');
  if (error instanceof ApiError) {
    if (error.code === 'resets_unsupported') return t('errors:resets.unsupported');
    if (error.code === 'reset_in_progress') return t('errors:redeem.reset_in_progress');
    if (error.code === 'invalid_request') return t('errors:redeem.invalid_request');
  }
  return describeError(error);
}

/** Loop mode error codes (the body's `error`). An unknown code falls back to `describeError`. */
const LOOP_ERROR_CODES = ['loop_not_found', 'loop_finished', 'loop_busy', 'not_acp'] as const;

/** Text for the loop API errors, read from the body code. Other errors fall back to `describeError`. */
export function describeLoopError(error: unknown): string {
  const code = knownCode(LOOP_ERROR_CODES, error);
  if (code !== null) return t(`errors:loop.${code}`);
  return describeError(error);
}

/** Account error codes (the body's `error`). A code that is not here falls back to `describeError`. */
const ACCOUNT_ERROR_CODES = [
  'accounts_unsupported',
  'account_in_use',
  'too_many_accounts',
  'login_in_progress',
  'invalid_state',
  'session_busy',
  'not_resumable',
  'not_found',
] as const;

/** Text for the account API errors (list, login, rename, remove, session account), read from the body code. */
export function describeAccountError(error: unknown): string {
  const code = knownCode(ACCOUNT_ERROR_CODES, error);
  if (code !== null) return t(`errors:account.${code}`);
  return describeError(error);
}

/**
 * Text for `PUT /api/sessions/:id/account`. The 404 there is a missing session, not a missing account, so it must not
 * use the account text. The other codes read as in `describeAccountError`.
 */
export function describeSessionAccountError(error: unknown): string {
  if (error instanceof ApiError && (error.code === 'not_found' || error.kind === 'not_found')) {
    return t('errors:sessionAccount.not_found');
  }
  return describeAccountError(error);
}

/** Text for a failed poll of the login state: the daemon forgot the login, the PC is unreachable, or anything else. */
export function describeLoginPollError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'not_found') return t('errors:loginPoll.not_found');
    if (error.kind === 'network') return t('errors:loginPoll.network');
  }
  return describeAccountError(error);
}
