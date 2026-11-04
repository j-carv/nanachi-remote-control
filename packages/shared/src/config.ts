import { z } from 'zod';

/** Como o daemon conversa com o agente: ACP (JSON-RPC via stdio) ou PTY (terminal interativo). */
export const AgentKindSchema = z.enum(['acp', 'pty']);

export type AgentKind = z.infer<typeof AgentKindSchema>;

/** Agente configurado em `agents` do config.json (ex.: omp). `kind` default `acp`. */
export const AgentConfigSchema = z.object({
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  kind: AgentKindSchema.default('acp'),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Agentes que todo daemon conhece. Quando o config.json do usuário não define um id, o daemon usa o default
 * em memória (o arquivo não é reescrito); quando define, o do arquivo vence.
 */
export const DEFAULT_AGENTS: Readonly<Record<string, AgentConfig>> = {
  omp: { label: 'Oh My Pi', command: 'omp', args: ['acp'], env: {}, kind: 'acp' },
  claude: { label: 'Claude Code', command: 'claude-agent-acp', args: [], env: {}, kind: 'acp' },
  codex: { label: 'Codex', command: 'codex-acp', args: [], env: {}, kind: 'acp' },
  agy: { label: 'Antigravity', command: 'agy', args: [], env: {}, kind: 'pty' },
};

/** Config do daemon em `<NANACHI_HOME>/config.json`. `machineName` é preenchido pelo daemon com o hostname. */
export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(7777),
  /** Só loopback: o daemon fica exposto apenas via `tailscale serve`, nunca direto na rede. */
  host: z.enum(['127.0.0.1', '::1', 'localhost']).default('127.0.0.1'),
  machineName: z.string().min(1).optional(),
  allowedRoots: z.array(z.string()).default([]),
  allowedTailscaleLogins: z.array(z.string()).default([]),
  corsOrigins: z.array(z.string()).default([]),
  /** Aviso ao agente, no primeiro prompt de sessão criada pelo app, de como mandar arquivo ao celular (phone-send). */
  phoneSendHint: z.boolean().default(true),
  /** Período sem mudanças nas pastas de build antes de recarregar o daemon (só com --reload-on-build). Padrão: 60 s. */
  reloadQuietMs: z.number().int().min(0).default(60_000),
  agents: z
    .record(z.string(), AgentConfigSchema)
    .default(() => ({ ...DEFAULT_AGENTS })),
});

export type Config = z.infer<typeof ConfigSchema>;
