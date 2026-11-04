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
