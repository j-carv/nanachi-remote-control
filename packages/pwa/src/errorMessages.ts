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
