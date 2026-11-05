import { describe, expect, it, vi } from 'vitest';
import { getDesktopBridge, isDesktopBridge } from './bridge.js';
import { followDesktopLanguage } from './language.js';

type Listener = (language: unknown) => void;

/** A bridge with the language event, the way Nanachi Desktop exposes it: `emit` is what main sends. */
function bridgeWithLanguage() {
  const listeners = new Set<Listener>();
  return {
    bridge: {
      onLanguage(callback: Listener) {
        listeners.add(callback);
        return () => void listeners.delete(callback);
      },
    },
    emit: (language: unknown) => listeners.forEach((listener) => listener(language)),
    listeners,
  };
}

describe('followDesktopLanguage', () => {
  it('switches the app to the language Desktop announces, for each of the three', () => {
    const { bridge, emit } = bridgeWithLanguage();
    const apply = vi.fn();
    expect(followDesktopLanguage(bridge, apply)).not.toBeNull();
    for (const language of ['en', 'es', 'pt-BR']) emit(language);
    expect(apply.mock.calls).toEqual([['en'], ['es'], ['pt-BR']]);
  });

  it('ignores a value that is not one of the supported languages', () => {
    const { bridge, emit } = bridgeWithLanguage();
    const apply = vi.fn();
    followDesktopLanguage(bridge, apply);
    for (const value of ['fr', 'pt', 'EN', '', null, undefined, 7, {}, ['en']]) emit(value);
    expect(apply).not.toHaveBeenCalled();
  });

  it('stops following when the returned function is called', () => {
    const { bridge, emit, listeners } = bridgeWithLanguage();
    const apply = vi.fn();
    const stop = followDesktopLanguage(bridge, apply);
    stop?.();
    emit('en');
    expect(apply).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('does nothing outside Desktop, and with a Desktop that has no language event (an older one)', () => {
    const apply = vi.fn();
    expect(followDesktopLanguage(null, apply)).toBeNull();
    expect(followDesktopLanguage({}, apply)).toBeNull();
    expect(followDesktopLanguage({ onLanguage: 'not a function' as never }, apply)).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('the Desktop bridge guard and the language event', () => {
  const noop = (): Promise<never> => new Promise(() => undefined);
  const unsubscribe = (): (() => void) => () => undefined;
  const older = {
    version: '0.1.0',
    status: noop,
    onStatus: unsubscribe,
    pairingCode: noop,
    getAutostart: noop,
    setAutostart: noop,
    checkForUpdate: noop,
    tailscale: { status: noop, start: noop, stop: noop, onStatus: unsubscribe },
  };

  it('still accepts a Desktop without onLanguage: the Desktop section of Settings must not disappear with an older install', () => {
    expect(isDesktopBridge(older)).toBe(true);
    expect(getDesktopBridge({ nanachiDesktop: older })).toBe(older);
  });

  it('accepts one with it', () => {
    expect(isDesktopBridge({ ...older, onLanguage: unsubscribe })).toBe(true);
  });
});
