import { describe, expect, it, vi } from 'vitest';
import { EVENT_CHANNELS } from '../src/common/channels.js';
import type { ControlSection, SessionsViewport } from '../src/common/control-api.js';
import type { Language } from '../src/common/i18n/languages.js';
import type { InputLike } from '../src/common/shortcuts.js';
import type { DaemonStatus } from '../src/common/types.js';
import { createSessionsView, DEATH_WINDOW_MS, MAX_DEATHS_IN_WINDOW, type SessionsHost, type ViewHandle } from '../src/main/sessions-view.js';
import type { SessionsViewState } from '../src/common/control-api.js';
import type { ViewBounds } from '../src/main/sessions-viewport.js';

function status(patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return { state: 'running', port: 7780, mode: 'spawned', pid: 1, version: '0.1.0', machineName: 'PC', restricted: false, message: null, logTail: [], ...patch };
}

class FakeView implements ViewHandle {
  bounds: ViewBounds | null = null;
  visible = false;
  disposed = false;
  loads: string[] = [];
  reloads = 0;
  focused = 0;
  url = '';
  sent: Array<[string, unknown]> = [];
  gone: Array<(reason: string) => void> = [];
  inputs: Array<(input: InputLike, consume: () => void) => void> = [];
  loadResult: Promise<void> = Promise.resolve();
  loading = false;
  readonly contents = {
    loadURL: (url: string): Promise<void> => {
      this.loads.push(url);
      return this.loadResult;
    },
    reload: (): void => {
      this.reloads += 1;
    },
    isDestroyed: (): boolean => this.disposed,
    isLoading: (): boolean => this.loading,
    getURL: (): string => this.url,
    send: (channel: string, payload: unknown): void => {
      this.sent.push([channel, payload]);
    },
    focus: (): void => {
      this.focused += 1;
    },
  };
  setBounds(bounds: ViewBounds): void {
    this.bounds = bounds;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  onRenderGone(listener: (reason: string) => void): void {
    this.gone.push(listener);
  }
  onInput(listener: (input: InputLike, consume: () => void) => void): void {
    this.inputs.push(listener);
  }
  dispose(): void {
    this.disposed = true;
  }
}

const rect = { x: 232, y: 40, width: 948, height: 720 };
const report = (extra: Partial<SessionsViewport> = {}): SessionsViewport => ({ ...rect, active: true, covered: false, ...extra });

function setup(initial: Partial<DaemonStatus> = {}) {
  let current = status(initial);
  let size: { width: number; height: number } | null = { width: 1180, height: 760 };
  const views: FakeView[] = [];
  const attached: FakeView[] = [];
  const detached: FakeView[] = [];
  const resizers = new Set<() => void>();
  const shortcuts: ControlSection[] = [];
  const notes: string[] = [];
  const focusPage = vi.fn();
  const prepare = vi.fn(() => Promise.resolve());
  const states: SessionsViewState[] = [];
  let focused = true;
  let clock = 1_000_000;
  const host: SessionsHost = {
    contentSize: () => size,
    isFocused: () => focused,
    attach: (handle) => void attached.push(handle as FakeView),
    detach: (handle) => void detached.push(handle as FakeView),
    focusPage,
    onResize: (listener) => {
      resizers.add(listener);
      return () => void resizers.delete(listener);
    },
  };
  const view = createSessionsView({
    host,
    origin: () => `http://127.0.0.1:${current.port}`,
    daemonStatus: () => current,
    createView: () => {
      const created = new FakeView();
      views.push(created);
      return created;
    },
    prepare,
    onShortcut: (section) => void shortcuts.push(section),
    viewState: (state) => void states.push(state),
    now: () => clock,
    note: (text) => void notes.push(text),
  });
  return {
    view,
    views,
    states,
    setFocused(value: boolean) {
      focused = value;
    },
    advance(ms: number) {
      clock += ms;
    },
    attached,
    detached,
    shortcuts,
    notes,
    focusPage,
    prepare,
    setStatus(next: Partial<DaemonStatus>) {
      current = status({ ...current, ...next });
      view.onDaemonStatus(current);
    },
    resize(next: { width: number; height: number } | null) {
      size = next;
      for (const listener of resizers) listener();
    },
  };
}

/** Lets the async load (prepare, then loadURL) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the sessions view is created only when there is something to show', () => {
  it('does not exist before the page reports, nor while another section is on screen', () => {
    const t = setup();
    expect(t.view.exists()).toBe(false);
    t.view.setViewport(report({ active: false }));
    expect(t.views).toHaveLength(0);
    expect(t.view.exists()).toBe(false);
  });

  it('is created, attached, placed, loaded from the daemon origin and shown the first time the section is on screen', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    expect(t.views).toHaveLength(1);
    const created = t.views[0] as FakeView;
    expect(t.attached).toEqual([created]);
    expect(created.bounds).toEqual(rect);
    expect(created.visible).toBe(true);
    expect(created.loads).toEqual(['http://127.0.0.1:7780/']);
    expect(t.prepare).toHaveBeenCalledTimes(1);
    expect(created.focused).toBe(1);
    expect(t.view.exists()).toBe(true);
  });

  it('is never created while the daemon is not ready, whatever the page says', () => {
    for (const patch of [{ state: 'starting' as const }, { state: 'stopped' as const }, { state: 'error' as const }, { restricted: true }]) {
      const t = setup(patch);
      t.view.setViewport(report());
      expect(t.views, JSON.stringify(patch)).toHaveLength(0);
    }
  });

  it('loads the PWA even when pairing fails (the PWA offers its own pairing screen)', async () => {
    const t = setup();
    t.prepare.mockRejectedValueOnce(new Error('sem pareamento'));
    t.view.setViewport(report());
    await settle();
    expect((t.views[0] as FakeView).loads).toEqual(['http://127.0.0.1:7780/']);
  });
});

describe('the bounds and the visibility follow what the page reports', () => {
  it('moves with a new rectangle (sidebar collapsed) and keeps the same view', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ x: 64, width: 1116 }));
    const created = t.views[0] as FakeView;
    expect(t.views).toHaveLength(1);
    expect(created.bounds).toEqual({ x: 64, y: 40, width: 1116, height: 720 });
    expect(created.focused).toBe(1);
  });

  it('hides when another section is selected, and gives the keyboard back to the page', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ active: false }));
    const created = t.views[0] as FakeView;
    expect(created.visible).toBe(false);
    expect(t.focusPage).toHaveBeenCalledTimes(1);
    expect(created.disposed).toBe(false);
  });

  it('comes back to the same page, not a new one, and takes the keyboard again', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ active: false }));
    t.view.setViewport(report());
    const created = t.views[0] as FakeView;
    expect(t.views).toHaveLength(1);
    expect(created.visible).toBe(true);
    expect(created.focused).toBe(2);
    expect(created.loads).toHaveLength(1);
  });

  it('steps aside while a dialog or toast covers the area', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ covered: true }));
    expect((t.views[0] as FakeView).visible).toBe(false);
    t.view.setViewport(report({ covered: false }));
    expect((t.views[0] as FakeView).visible).toBe(true);
  });

  it('does not take the keyboard again on a resize that changes nothing about visibility', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ height: 700 }));
    t.view.setViewport(report({ height: 690 }));
    expect((t.views[0] as FakeView).focused).toBe(1);
    expect(t.focusPage).not.toHaveBeenCalled();
  });

  it('follows a window resize at once, clamped to the new content, before the page reports again', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.resize({ width: 940, height: 620 });
    expect((t.views[0] as FakeView).bounds).toEqual({ x: 232, y: 40, width: 708, height: 580 });
    t.resize({ width: 1500, height: 900 });
    expect((t.views[0] as FakeView).bounds).toEqual(rect);
  });

  it('hides when the window has no content area (no window), without throwing', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.resize(null);
    expect((t.views[0] as FakeView).visible).toBe(false);
  });
});

describe('the daemon changes under the view', () => {
  it('hides the view while the daemon is not ready, and loads again when it is back (a restart)', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    t.setStatus({ state: 'starting', pid: null });
    expect(created.visible).toBe(false);
    t.setStatus({ state: 'running', pid: 2 });
    await settle();
    expect(created.visible).toBe(true);
    expect(created.loads).toEqual(['http://127.0.0.1:7780/', 'http://127.0.0.1:7780/']);
    expect(t.prepare).toHaveBeenCalledTimes(2);
    expect(t.views).toHaveLength(1);
  });

  it('does not reload for a status that only refreshes details while the daemon stays ready', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.setStatus({ version: '0.1.1' });
    await settle();
    expect((t.views[0] as FakeView).loads).toHaveLength(1);
  });

  it('loads the new address when the daemon moved to another port', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.setStatus({ port: 7791 });
    await settle();
    expect((t.views[0] as FakeView).loads).toEqual(['http://127.0.0.1:7780/', 'http://127.0.0.1:7791/']);
  });

  it('a daemon that becomes ready while the section is on screen creates the view then', async () => {
    const t = setup({ state: 'starting', pid: null });
    t.view.setViewport(report());
    expect(t.views).toHaveLength(0);
    t.setStatus({ state: 'running', pid: 3 });
    await settle();
    expect(t.views).toHaveLength(1);
    expect((t.views[0] as FakeView).visible).toBe(true);
    expect((t.views[0] as FakeView).loads).toEqual(['http://127.0.0.1:7780/']);
  });

  it('a restricted daemon hides the view (the page shows its own explanation)', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.setStatus({ restricted: true });
    expect((t.views[0] as FakeView).visible).toBe(false);
  });
});

describe('recovery', () => {
  it('a renderer that died is replaced by a fresh view, at once when the section is on screen', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const first = t.views[0] as FakeView;
    first.gone[0]?.('crashed');
    await settle();
    expect(first.disposed).toBe(true);
    expect(t.detached).toEqual([first]);
    expect(t.views).toHaveLength(2);
    const second = t.views[1] as FakeView;
    expect(second.visible).toBe(true);
    expect(second.bounds).toEqual(rect);
    expect(second.loads).toEqual(['http://127.0.0.1:7780/']);
    expect(t.notes.some((note) => note.includes('crashed'))).toBe(true);
  });

  it('a renderer that died while another section is on screen is replaced the next time the section opens', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ active: false }));
    (t.views[0] as FakeView).gone[0]?.('oom');
    expect(t.views).toHaveLength(1);
    t.view.setViewport(report());
    await settle();
    expect(t.views).toHaveLength(2);
    expect((t.views[1] as FakeView).visible).toBe(true);
  });

  it('a late answer of the dead view does not touch the new one', async () => {
    const t = setup();
    t.view.setViewport(report());
    const first = t.views[0] as FakeView;
    first.gone[0]?.('crashed');
    await settle();
    expect(first.loads.length + (t.views[1] as FakeView).loads.length).toBeLessThanOrEqual(2);
  });

  it('reload() reloads the page that is there, and does nothing before one exists (a 401 re-pair)', async () => {
    const t = setup();
    t.view.reload();
    t.view.setViewport(report());
    await settle();
    t.view.reload();
    expect((t.views[0] as FakeView).reloads).toBe(1);
  });

  it('a language change reaches the page that is there through the bridge event, without reloading it (an unsent draft survives)', async () => {
    const t = setup();
    expect(t.view.languageChanged('en')).toBe('none');
    expect(t.views).toHaveLength(0);
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    created.url = 'http://127.0.0.1:7780/';
    for (const language of ['en', 'es', 'pt-BR'] satisfies Language[]) expect(t.view.languageChanged(language)).toBe('sent');
    expect(created.sent).toEqual([
      [EVENT_CHANNELS.language, 'en'],
      [EVENT_CHANNELS.language, 'es'],
      [EVENT_CHANNELS.language, 'pt-BR'],
    ]);
    expect(created.reloads).toBe(0);
  });

  it('a language change while the page is still loading reloads it: the preload then hands it the new language', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    created.url = 'http://127.0.0.1:7780/';
    created.loading = true;
    expect(t.view.languageChanged('es')).toBe('reloaded');
    expect(created.reloads).toBe(1);
    expect(created.sent).toEqual([]);
  });

  it('a language change is dropped (nothing sent, nothing reloaded) while the page is not on the daemon origin', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    created.url = 'about:blank';
    expect(t.view.languageChanged('es')).toBe('none');
    expect(created.sent).toEqual([]);
    expect(created.reloads).toBe(0);
  });

  it('a failed load is logged and does not stop the next one', async () => {
    const t = setup();
    t.view.setViewport(report());
    const first = t.views[0] as FakeView;
    first.loadResult = Promise.reject(new Error('ERR_CONNECTION_REFUSED'));
    first.loadResult.catch(() => undefined);
    await settle();
    await settle();
    t.setStatus({ state: 'starting' });
    t.setStatus({ state: 'running' });
    await settle();
    expect(first.loads.length).toBe(2);
    expect(t.notes.some((note) => note.includes('ERR_CONNECTION_REFUSED'))).toBe(true);
  });
});

describe('a page that keeps dying', () => {
  /** Opens the section and lets the first view load. */
  async function opened() {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    return t;
  }

  it('allows one replacement: the second death within 30 s does not create a third view, and the page is told', async () => {
    expect(MAX_DEATHS_IN_WINDOW).toBe(2);
    expect(DEATH_WINDOW_MS).toBe(30_000);
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    expect(t.views).toHaveLength(2);
    expect(t.states).toEqual([]);
    t.advance(2_000);
    (t.views[1] as FakeView).gone[0]?.('crashed');
    await settle();
    expect(t.views).toHaveLength(2);
    expect((t.views[1] as FakeView).disposed).toBe(true);
    expect(t.view.exists()).toBe(false);
    expect(t.states).toEqual(['crashed']);
    expect(t.notes.some((note) => note.includes('não será recriada'))).toBe(true);
  });

  it('keeps the area free for the page while it has given up, however the window or the daemon changes', async () => {
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    (t.views[1] as FakeView).gone[0]?.('crashed');
    t.resize({ width: 1500, height: 900 });
    t.setStatus({ state: 'starting', pid: null });
    t.setStatus({ state: 'running', pid: 5 });
    await settle();
    t.view.setViewport(report({ covered: true }));
    t.view.setViewport(report());
    expect(t.views).toHaveLength(2);
  });

  it('tells the page again with every report while it has given up (a page that was reloaded learns it)', async () => {
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    (t.views[1] as FakeView).gone[0]?.('crashed');
    t.view.setViewport(report({ height: 700 }));
    expect(t.states).toEqual(['crashed', 'crashed']);
  });

  it('comes back the next time the section is opened, with a fresh count, and the page is told it is fine', async () => {
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    (t.views[1] as FakeView).gone[0]?.('crashed');
    t.view.setViewport(report({ active: false }));
    expect(t.views).toHaveLength(2);
    t.view.setViewport(report());
    await settle();
    expect(t.views).toHaveLength(3);
    expect((t.views[2] as FakeView).visible).toBe(true);
    expect(t.states).toEqual(['crashed', 'ok']);
    // The count starts again: one death is replaced, the next one within the window is not.
    (t.views[2] as FakeView).gone[0]?.('crashed');
    expect(t.views).toHaveLength(4);
    (t.views[3] as FakeView).gone[0]?.('crashed');
    expect(t.views).toHaveLength(4);
    expect(t.states).toEqual(['crashed', 'ok', 'crashed']);
  });

  it('does not count a dozen resizes or reports as the section being opened again', async () => {
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    (t.views[1] as FakeView).gone[0]?.('crashed');
    for (let step = 0; step < 12; step += 1) t.view.setViewport(report({ height: 700 + step }));
    expect(t.views).toHaveLength(2);
    expect(t.states.every((state) => state === 'crashed')).toBe(true);
  });

  it('forgets a death after 30 s: deaths farther apart than that each get a fresh view', async () => {
    const t = await opened();
    (t.views[0] as FakeView).gone[0]?.('crashed');
    t.advance(DEATH_WINDOW_MS + 1);
    (t.views[1] as FakeView).gone[0]?.('crashed');
    expect(t.views).toHaveLength(3);
    t.advance(DEATH_WINDOW_MS + 1);
    (t.views[2] as FakeView).gone[0]?.('crashed');
    expect(t.views).toHaveLength(4);
    expect(t.states).toEqual([]);
  });

  it('counts a death while another section is on screen, so the next one after reopening is the second', async () => {
    const t = await opened();
    t.view.setViewport(report({ active: false }));
    (t.views[0] as FakeView).gone[0]?.('oom');
    expect(t.views).toHaveLength(1);
    t.view.setViewport(report());
    await settle();
    expect(t.views).toHaveLength(2);
    (t.views[1] as FakeView).gone[0]?.('oom');
    expect(t.views).toHaveLength(2);
    expect(t.states).toEqual(['crashed']);
  });
});

describe('the keyboard focus', () => {
  it('goes to the PWA when it appears while the control window has the focus', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    expect((t.views[0] as FakeView).focused).toBe(1);
  });

  it('is not taken from another application: the view that appears or hides in the background leaves the focus alone', async () => {
    const t = setup();
    t.setFocused(false);
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    expect(created.visible).toBe(true);
    expect(created.focused).toBe(0);
    t.view.setViewport(report({ active: false }));
    expect(created.visible).toBe(false);
    expect(t.focusPage).not.toHaveBeenCalled();
  });

  it('is given back to the page when the view hides while the control window has the focus', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    t.view.setViewport(report({ active: false }));
    expect(t.focusPage).toHaveBeenCalledTimes(1);
  });
});

describe('the keyboard inside the view', () => {
  const input = (key: string, extra: Partial<InputLike> = {}): InputLike => ({ type: 'keyDown', key, control: true, alt: false, shift: false, meta: false, ...extra });

  it('hands Ctrl+1..8 to the page and keeps them from the PWA', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const consume = vi.fn();
    (t.views[0] as FakeView).inputs[0]?.(input('1'), consume);
    (t.views[0] as FakeView).inputs[0]?.(input('8'), consume);
    expect(t.shortcuts).toEqual(['overview', 'sessions']);
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it('leaves every other key to the PWA', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const consume = vi.fn();
    for (const next of [input('k'), input('9'), input('1', { control: false }), input('1', { type: 'keyUp' })]) (t.views[0] as FakeView).inputs[0]?.(next, consume);
    expect(t.shortcuts).toEqual([]);
    expect(consume).not.toHaveBeenCalled();
  });
});

describe('destroy', () => {
  it('detaches and closes the view, stops following the window, and ignores everything after', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    t.view.destroy();
    expect(created.disposed).toBe(true);
    expect(t.detached).toEqual([created]);
    t.view.setViewport(report());
    t.resize({ width: 900, height: 600 });
    expect(t.views).toHaveLength(1);
    expect(t.view.exists()).toBe(false);
  });
});

describe('events for the PWA', () => {
  it('reach the page only while it shows the daemon origin and only on the bridge event channels', async () => {
    const t = setup();
    t.view.send(EVENT_CHANNELS.status, { before: 'there is no view yet' });
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    created.url = 'http://127.0.0.1:7780/';
    t.view.send(EVENT_CHANNELS.status, { state: 'running' });
    t.view.send('control:navigate', 'sessions');
    t.view.send('anything:else', {});
    expect(created.sent).toEqual([[EVENT_CHANNELS.status, { state: 'running' }]]);
  });

  it('are dropped while the page is on another address (a navigation that should never happen, or still blank)', async () => {
    const t = setup();
    t.view.setViewport(report());
    await settle();
    const created = t.views[0] as FakeView;
    for (const url of ['', 'about:blank', 'http://127.0.0.1:7777/', 'https://evil.example/']) {
      created.url = url;
      t.view.send(EVENT_CHANNELS.status, {});
    }
    expect(created.sent).toEqual([]);
  });
});
