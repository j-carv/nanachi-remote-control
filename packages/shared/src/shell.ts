import { z } from 'zod';

/**
 * Agent id reserved for the terminal of a workspace (`POST /api/sessions` with `agent: "shell"`). It is not an entry
 * of `agents` in the config: the daemon checks it before looking the agent up, so a config entry with this id is ignored.
 */
export const SHELL_AGENT_ID = 'shell';

/** Shells que o daemon sabe abrir. `bash` é só o Git Bash (nunca o WSL). */
export const SHELL_IDS = ['powershell', 'pwsh', 'cmd', 'bash'] as const;

export const ShellIdSchema = z.enum(SHELL_IDS);

export type ShellId = z.infer<typeof ShellIdSchema>;

/**
 * GET /api/shells (Bearer token): só os shells encontrados neste PC. `isDefault` marca o que é usado quando o pedido
 * não escolhe um. Lista vazia quando `shellSessions` está desligado no config.
 */
export const ShellsResponseSchema = z.object({
  shells: z.array(
    z.object({
      id: ShellIdSchema,
      label: z.string().min(1),
      isDefault: z.boolean(),
    }),
  ),
});

export type ShellsResponse = z.infer<typeof ShellsResponseSchema>;
