import { describe, expect, it } from 'vitest';
import { activeRoute, depthOf, goToDepth, initialNav, pushNav, type NavState, type Route } from '../navigation.js';
import { createModalOverlay, type HistoryPort } from './useModalOverlay.js';

/**
 * Browser history as the overlays see it. pushState is immediate and drops the forward entries. back() and the
 * user's back gesture are queued, like a real traversal: they run on `flush()`, after the script that asked for them.
 */
class FakeBrowser implements HistoryPort {
  /** What happened, in order: `back` (requested), `gesture`, `pop` (applied), and the test's own marks. */
  readonly events: string[] = [];
  private entries: unknown[] = [{ depth: 0 }];
  private index = 0;
  private tasks: Array<() => void> = [];
  private listeners: Array<() => void> = [];

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(state: unknown): void {
    this.entries = [...this.entries.slice(0, this.index + 1), state];
    this.index = this.entries.length - 1;
  }

  push(): void {
    this.pushState(this.state);
  }

  back(): void {
    this.events.push('back');
    this.tasks.push(() => this.traverse(this.index - 1));
  }

  gestureBack(): void {
    this.tasks.push(() => {
      this.events.push('gesture');
      this.traverse(this.index - 1);
    });
  }

  onPop(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  flush(): void {
    for (let task = this.tasks.shift(); task !== undefined; task = this.tasks.shift()) task();
  }

  private traverse(target: number): void {
    if (target < 0) return;
    this.index = target;
    this.events.push('pop');
    for (const listener of [...this.listeners]) listener();
  }
}

/** The app's screen stack, kept the way App.tsx keeps it: pushes add entries, popstate goes to a depth. */
function mountApp(browser: FakeBrowser) {
  let nav: NavState = initialNav({ kind: 'home' });
  browser.onPop(() => {
    nav = goToDepth(nav, depthOf(browser.state));
  });
  return {
    get nav(): NavState {
      return nav;
    },
    push(route: Route): void {
      const next = pushNav(nav, route);
      browser.pushState({ depth: next.depth });
      nav = next.nav;
    },
  };
}

function setup() {
  const browser = new FakeBrowser();
  const app = mountApp(browser);
  app.push({ kind: 'settings' });
  let dismissals = 0;
  const overlay = createModalOverlay(browser, () => {
    dismissals += 1;
  });
  overlay.open();
  return { browser, app, overlay, dismissals: () => dismissals };
}

describe('createModalOverlay', () => {
  it('runs a picked action only after the pop of the sheet entry', () => {
    const { browser, app, overlay, dismissals } = setup();
    overlay.closeThen(() => browser.events.push('action'));

    expect(dismissals()).toBe(1);
    overlay.close(); // the unmount that follows the dismissal
    expect(browser.events).toEqual(['back']);

    browser.flush();
    expect(browser.events).toEqual(['back', 'pop', 'action']);
    expect(activeRoute(app.nav).kind).toBe('settings');
  });

  it('keeps the entry that a picked action pushes, because the sheet pop runs first', () => {
    const { browser, app, overlay } = setup();
    overlay.closeThen(() => app.push({ kind: 'workspaces' }));
    overlay.close();
    browser.flush();

    expect(activeRoute(app.nav).kind).toBe('workspaces');
    expect(browser.state).toEqual({ depth: 2 });
  });

  it('pops its entry once when closed without a pick', () => {
    const { browser, app, overlay } = setup();
    overlay.close();
    browser.flush();

    expect(browser.events).toEqual(['back', 'pop']);
    expect(activeRoute(app.nav).kind).toBe('settings');
  });

  it('dismisses once on the back gesture and does not pop a second time', () => {
    const { browser, app, overlay, dismissals } = setup();
    browser.gestureBack();
    browser.flush();
    expect(dismissals()).toBe(1);

    overlay.close(); // the unmount that follows the dismissal
    browser.flush();

    expect(browser.events).toEqual(['gesture', 'pop']);
    expect(activeRoute(app.nav).kind).toBe('settings');
  });
});
