import { PushSubscriptionRequestSchema, type PushSubscriptionRequest } from '@nanachi/shared';
import type { Language } from '../i18n/languages.js';

/** JSON do PushSubscription do navegador no corpo que o daemon espera; null se faltar algo. */
export function toSubscriptionRequest(json: unknown): PushSubscriptionRequest | null {
  if (typeof json !== 'object' || json === null) return null;
  const { endpoint, keys } = json as { endpoint?: unknown; keys?: unknown };
  const parsed = PushSubscriptionRequestSchema.safeParse({ endpoint, keys });
  return parsed.success ? parsed.data : null;
}

/** The subscription with the app language: the daemon stores it and writes this phone's push texts in it. */
export function subscriptionInLanguage(request: PushSubscriptionRequest, language: Language): PushSubscriptionRequest {
  return { ...request, language };
}

/** A machine that receives this phone's subscription (its API client). */
export interface SubscriptionTarget {
  subscribePush(input: PushSubscriptionRequest): Promise<void>;
}

/**
 * The app language changed: sends this phone's subscription again, with the new language, to every target machine.
 * No subscription (or an invalid one) sends nothing. Best effort: a machine that fails does not stop the others, and the
 * daemon keeps the old language until the next change or the next activation.
 */
export async function resendSubscriptionLanguage(input: {
  /** This phone's PushSubscription as JSON (`toJSON()`), or null when there is no subscription. */
  subscription: unknown;
  language: Language;
  targets: readonly SubscriptionTarget[];
}): Promise<void> {
  const request = toSubscriptionRequest(input.subscription);
  if (request === null) return;
  const withLanguage = subscriptionInLanguage(request, input.language);
  await Promise.all(
    input.targets.map((target) =>
      target.subscribePush(withLanguage).catch(() => undefined),
    ),
  );
}
