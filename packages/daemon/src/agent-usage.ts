/**
 * Comando de uso por agente, pelo id do agente no config (o mesmo de DEFAULT_AGENTS). Verificado com o probe ACP
 * de 04/11 (docs/PLAN.md, "uso do agente"): só comandos locais, nenhum deles chama o LLM.
 * - omp `/usage`: percentuais das janelas de 5 h e 7 dias por conta (texto com ANSI).
 * - claude-agent-acp `/usage`: limite de 5 h, semanal e custo da sessão.
 * - codex-acp `/status`: limites de 5 h e semanal (`/usage` não é anunciado pelo codex).
 */
const USAGE_COMMANDS: Readonly<Record<string, string>> = {
  omp: '/usage',
  claude: '/usage',
  codex: '/status',
};

/** Teto da leitura de uso (subir o processo, negociar e responder). Passou disso, o daemon manda session/cancel. */
export const USAGE_TIMEOUT_MS = 30_000;

/**
 * Agents whose cold read needs more than USAGE_TIMEOUT_MS. Claude Code: starting the adapter, initialize, session/new and
 * a cold `/usage` were measured at 19 s and went past 30 s for an extra account; the probe is killed on timeout, so every
 * retry started cold again and never succeeded.
 */
const USAGE_TIMEOUT_BY_AGENT: Readonly<Record<string, number>> = {
  claude: 90_000,
};

/** The time budget of a usage read for the agent `agentId` (config id). */
export function usageTimeoutOf(agentId: string): number {
  return Object.hasOwn(USAGE_TIMEOUT_BY_AGENT, agentId) ? (USAGE_TIMEOUT_BY_AGENT[agentId] ?? USAGE_TIMEOUT_MS) : USAGE_TIMEOUT_MS;
}

/** Uma leitura de uso vale por este prazo: chamadas dentro dele recebem a mesma resposta, com `cached: true`. */
export const USAGE_CACHE_MS = 30_000;

/** Processo de uso parado sem leitura por este prazo morre; o próximo pedido sobe outro (e retoma a sessão de uso). */
export const USAGE_IDLE_MS = 120_000;

/** Depois do session/cancel, tempo máximo de espera pelo fim do turno antes de responder. */
export const USAGE_CANCEL_GRACE_MS = 5_000;

/** Texto do comando de uso para o agente, ou undefined se o agente não tem um (PTY, id desconhecido). */
export function usageCommandOf(agentId: string): string | undefined {
  return Object.hasOwn(USAGE_COMMANDS, agentId) ? USAGE_COMMANDS[agentId] : undefined;
}
