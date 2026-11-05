import { z } from 'zod';

/**
 * GET /api/pair/tailscale (sem token). `available` é true só quando `tailscaleAutoPair` está ligado e o login do
 * `Tailscale-User-Login` (com peer loopback) está em `allowedTailscaleLogins`. `login` vem só quando `available` é true.
 */
export const TailscalePairStatusResponseSchema = z
  .object({
    available: z.boolean(),
    login: z.string().min(1).optional(),
  })
  .refine((status) => status.available || status.login === undefined, {
    message: 'login só vem quando available é true',
    path: ['login'],
  });

export type TailscalePairStatusResponse = z.infer<typeof TailscalePairStatusResponseSchema>;

/** POST /api/pair/tailscale (sem token). Resposta: `PairResponseSchema`, igual ao pareamento por código. */
export const TailscalePairRequestSchema = z.object({
  deviceName: z.string().min(1).max(64),
});

export type TailscalePairRequest = z.infer<typeof TailscalePairRequestSchema>;
