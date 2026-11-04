import { PushSubscriptionRequestSchema, type PushSubscriptionRequest } from '@nanachi/shared';

/** JSON do PushSubscription do navegador no corpo que o daemon espera; null se faltar algo. */
export function toSubscriptionRequest(json: unknown): PushSubscriptionRequest | null {
  if (typeof json !== 'object' || json === null) return null;
  const { endpoint, keys } = json as { endpoint?: unknown; keys?: unknown };
  const parsed = PushSubscriptionRequestSchema.safeParse({ endpoint, keys });
  return parsed.success ? parsed.data : null;
}
