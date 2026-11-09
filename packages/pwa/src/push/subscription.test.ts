import type { PushSubscriptionRequest } from '@nanachi/shared';
import { describe, expect, it, vi } from 'vitest';
import { resendSubscriptionLanguage, subscriptionInLanguage, type SubscriptionTarget } from './subscription.js';

const REQUEST: PushSubscriptionRequest = {
  endpoint: 'https://web.push.apple.com/QGb4',
  keys: { p256dh: 'BPk3', auth: 'x9Lw' },
};

/** What the browser returns from PushSubscription.toJSON(): it has an extra field the subscription does not carry. */
const BROWSER_JSON = { ...REQUEST, expirationTime: null };

function machine(fails = false) {
  return {
    subscribePush: vi.fn<(input: PushSubscriptionRequest) => Promise<void>>(() =>
      fails ? Promise.reject(new Error('offline')) : Promise.resolve(),
    ),
  } satisfies SubscriptionTarget;
}

describe('subscriptionInLanguage', () => {
  it('adds the language and keeps the endpoint and keys', () => {
    expect(subscriptionInLanguage(REQUEST, 'en')).toEqual({ ...REQUEST, language: 'en' });
  });

  it('does not change the subscription it was given', () => {
    subscriptionInLanguage(REQUEST, 'es');
    expect(REQUEST).not.toHaveProperty('language');
  });
});

describe('resendSubscriptionLanguage', () => {
  it('sends this phone subscription with the new language to every target', async () => {
    const chosen = machine();
    const sameKey = machine();

    await resendSubscriptionLanguage({ subscription: BROWSER_JSON, language: 'en', targets: [chosen, sameKey] });

    expect(chosen.subscribePush).toHaveBeenCalledWith({ ...REQUEST, language: 'en' });
    expect(sameKey.subscribePush).toHaveBeenCalledWith({ ...REQUEST, language: 'en' });
  });

  it('sends nothing when this phone has no subscription', async () => {
    const chosen = machine();

    await resendSubscriptionLanguage({ subscription: null, language: 'es', targets: [chosen] });

    expect(chosen.subscribePush).not.toHaveBeenCalled();
  });

  it('sends nothing when the subscription is not valid', async () => {
    const chosen = machine();

    await resendSubscriptionLanguage({ subscription: { endpoint: 'nao-e-url' }, language: 'es', targets: [chosen] });

    expect(chosen.subscribePush).not.toHaveBeenCalled();
  });

  it('a machine that fails does not stop the others from receiving the language', async () => {
    const broken = machine(true);
    const fine = machine();

    await expect(
      resendSubscriptionLanguage({ subscription: BROWSER_JSON, language: 'es', targets: [broken, fine] }),
    ).resolves.toBeUndefined();

    expect(fine.subscribePush).toHaveBeenCalledWith({ ...REQUEST, language: 'es' });
  });
});
