import { ApiError, type ApiErrorKind } from './api.js';

/** Texto em pt-BR para cada tipo de erro da API. */
export const ERROR_TEXT: Record<ApiErrorKind, string> = {
  invalid_input: 'Revise os campos preenchidos e tente de novo.',
  invalid_code:
    'Código inválido, expirado ou já usado. Gere outro no PC com `npm run pair -w @nanachi/daemon`.',
  unauthorized: 'Este celular não tem mais acesso a esta máquina. Pareie de novo com um código novo.',
  forbidden: 'O daemon recusou o acesso (checagem do Tailscale). Confira allowedTailscaleLogins.',
  outside_roots: 'Esta pasta está fora das pastas permitidas no daemon (allowedRoots).',
  not_found: 'Não encontrei isso no PC. Pode ter sido removido.',
  not_a_directory: 'Isso não é uma pasta.',
  not_resumable: 'Este agente não permite retomar; abra uma sessão nova.',
  already_running: 'Esta sessão já está em execução.',
  already_linked: 'Esta sessão já está no app, parada. Abra e retome.',
  busy: 'Já há uma listagem em andamento para este agente. Espere uns segundos e tente de novo.',
  agent_timeout: 'O agente não respondeu no PC a tempo. Tente de novo.',
  agent_failed: 'O agente não subiu no PC. Confira se ele está instalado e logado.',
  too_many_sessions: 'Limite de 8 sessões ativas; pare alguma.',
  too_large: 'Arquivo maior que 50 MB.',
  rate_limited: 'Muitas tentativas erradas. Aguarde um minuto e tente de novo.',
  network: 'Não consegui falar com o PC. Confira o endereço e se o Tailscale está conectado.',
  not_git: 'Esta pasta não é um repositório git.',
  no_commits: 'O repositório ainda não tem commits.',
  worktree_dirty: 'O worktree tem alterações não commitadas; ele foi mantido.',
  unexpected: 'O servidor respondeu de forma inesperada. O daemon está atualizado?',
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.kind];
  return 'Erro inesperado.';
}

/**
 * Texto para os códigos de branch e de arquivo do workspace. O código do corpo vence o tipo: `file_too_large` e
 * `binary_file` não são tipos próprios. Código desconhecido cai em `describeError`.
 */
const WORKSPACE_ERROR_TEXT: Readonly<Record<string, string>> = {
  not_a_git_repo: 'Esta pasta não é um repositório git.',
  sessions_running: 'Há sessões rodando neste workspace. Espere terminarem ou encerre-as.',
  dirty_worktree: 'Há alterações não commitadas. Guarde ou commite antes de trocar de branch.',
  branch_in_use: 'Esta branch está aberta em outro worktree.',
  invalid_branch: 'Nome de branch inválido.',
  branch_exists: 'Já existe uma branch com esse nome.',
  branch_not_found: 'Essa branch não existe mais no PC.',
  invalid_path: 'Nome ou caminho inválido.',
  outside_workspace: 'Este caminho sai do workspace.',
  not_a_file: 'Isso não é um arquivo.',
  file_exists: 'Já existe um arquivo com esse nome.',
  already_exists: 'Já existe um item com esse nome.',
  file_changed: 'O arquivo mudou no PC desde que você abriu.',
  dir_not_empty: 'A pasta não está vazia. Apague o conteúdo primeiro.',
  binary_file: 'Arquivo binário: não dá para editar aqui.',
  file_too_large: 'Arquivo grande demais para o editor (máx. 2 MB).',
  too_many_writes: 'Muitas alterações seguidas. Aguarde um minuto e tente de novo.',
};

export function describeWorkspaceError(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const text = WORKSPACE_ERROR_TEXT[error.code];
    if (text !== undefined) return text;
  }
  return describeError(error);
}

/**
 * Text for the usage panel when `fetchSessionUsage` fails. It reads the body code, so it works for codes that
 * share a kind with other errors. Other errors fall back to `describeError`. ERROR_TEXT is not changed.
 */
export function describeUsageError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'session_not_active') return 'Retome a sessão para ver o uso.';
    if (error.code === 'session_busy') return 'O agente está ocupado; tente quando ele terminar.';
    if (error.code === 'usage_unsupported') return 'Este agente não informa uso.';
    if (error.status === 504) return 'O agente demorou para responder. Tente de novo.';
  }
  return describeError(error);
}

/** True when the usage error means the session must be resumed first (the panel then shows "Retomar"). */
export function usageNeedsResume(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'session_not_active';
}

const RESETS_UNSUPPORTED_TEXT = 'Este agente não tem resets salvos';

/** Text for the "Resets salvos" list when `getUsageResets` fails. Other errors fall back to `describeUsageError`. */
export function describeResetsError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'resets_unsupported') return RESETS_UNSUPPORTED_TEXT;
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

const REDEEM_UNCONFIRMED_TEXT = 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.';

/** Text for the usage panel when `redeemUsageReset` fails. See `redeemOutcomeUnknown` for the uncertain cases. */
export function describeRedeemError(error: unknown): string {
  if (redeemOutcomeUnknown(error)) return REDEEM_UNCONFIRMED_TEXT;
  if (error instanceof ApiError) {
    if (error.code === 'resets_unsupported') return RESETS_UNSUPPORTED_TEXT;
    if (error.code === 'reset_in_progress') return 'Já tem um reset em andamento.';
    if (error.code === 'invalid_request') return 'Esse reset não está mais na lista. Atualize o uso e tente de novo.';
  }
  return describeError(error);
}

/** Text for the Loop mode error codes (the body's `error`). An unknown code falls back to `describeError`. */
const LOOP_ERROR_TEXT: Readonly<Record<string, string>> = {
  loop_not_found: 'Esta sessão não tem loop. Crie um novo.',
  loop_finished: 'Este loop já terminou. Crie um novo para voltar a rodar.',
  loop_busy: 'Uma rodada do loop está em andamento. Espere ela terminar e tente de novo.',
  not_acp: 'O loop só roda em sessões de agente, não em terminal.',
};

/** Text for the loop API errors, read from the body code. Other errors fall back to `describeError`. */
export function describeLoopError(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const text = LOOP_ERROR_TEXT[error.code];
    if (text !== undefined) return text;
  }
  return describeError(error);
}

/** Text for the account error codes (the body's `error`). A code that is not here falls back to `describeError`. */
const ACCOUNT_ERROR_TEXT: Readonly<Record<string, string>> = {
  accounts_unsupported: 'Este agente não tem contas extras.',
  account_in_use: 'Uma sessão está trabalhando nesta conta. Espere terminar e tente de novo.',
  too_many_accounts: 'Limite de 10 contas extras por agente. Remova alguma antes de adicionar outra.',
  login_in_progress: 'Já há um login em andamento para este agente. Termine ou cancele esse primeiro.',
  invalid_state: 'O login não está esperando um código agora.',
  session_busy: 'O agente está trabalhando. Troque a conta quando ele terminar.',
  not_resumable: 'Este agente não retoma sessões: abra uma sessão nova na conta que você quer usar.',
  not_found: 'Não encontrei esta conta no PC. Atualize a lista.',
};

/** Text for the account API errors (list, login, rename, remove, session account), read from the body code. */
export function describeAccountError(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const text = ACCOUNT_ERROR_TEXT[error.code];
    if (text !== undefined) return text;
  }
  return describeError(error);
}

/**
 * Text for `PUT /api/sessions/:id/account`. The 404 there is a missing session, not a missing account, so it must not
 * use the account text. The other codes read as in `describeAccountError`.
 */
export function describeSessionAccountError(error: unknown): string {
  if (error instanceof ApiError && (error.code === 'not_found' || error.kind === 'not_found')) {
    return 'Não encontrei esta sessão no PC. Pode ter sido removida.';
  }
  return describeAccountError(error);
}

/** Text for a failed poll of the login state: the daemon forgot the login, the PC is unreachable, or anything else. */
export function describeLoginPollError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'not_found') return 'O PC não lembra mais deste login. Feche e tente de novo.';
    if (error.kind === 'network') return 'Sem resposta do PC. Tentando de novo…';
  }
  return describeAccountError(error);
}
