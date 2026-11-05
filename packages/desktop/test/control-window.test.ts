import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlSection } from '../src/common/control-api.js';
import type { ControlWindowBounds } from '../src/main/settings.js';

/**
 * A stand-in for Electron: just enough of `BrowserWindow` for `createControlWindow` to run, with the events the real one
 * emits. Nothing here opens a window.
 */
const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, listener: Listener): this {
      const wrapped: Listener = (...args) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: Listener): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
      );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeWebContents extends Emitter {
    reload = vi.fn();
    send = vi.fn();
    focus = vi.fn();
    setWindowOpenHandler = vi.fn();
    url = '';
    loading = false;
    getURL(): string {
      return this.url;
    }
    isLoading(): boolean {
      return this.loading;
    }
    isDestroyed(): boolean {
      return false;
    }
    readonly id = 7;
  }

  class FakeWindow extends Emitter {
    static all: FakeWindow[] = [];
    readonly webContents = new FakeWebContents();
    minimized = false;
    maximized = false;
    destroyed = false;
    visible = false;
    normalBounds = { x: 10, y: 20, width: 1180, height: 760 };
    show = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    focus = vi.fn();
    restore = vi.fn(() => {
      this.minimized = false;
    });
    minimize = vi.fn(() => {
      this.minimized = true;
    });
    maximize = vi.fn(() => {
      this.maximized = true;
    });
    unmaximize = vi.fn(() => {
      this.maximized = false;
    });
    removeMenu = vi.fn();
    setBackgroundColor = vi.fn();
    close = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    loadFile = vi.fn((_path: string, _options?: { query: Record<string, string> }) => Promise.resolve());
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    contentBounds = { x: 0, y: 0, width: 1180, height: 760 };
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return this.contentBounds;
    }
    constructor() {
      super();
      FakeWindow.all.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isMinimized(): boolean {
      return this.minimized;
    }
    isMaximized(): boolean {
      return this.maximized;
    }
    isFullScreen(): boolean {
      return false;
    }
    isFocused(): boolean {
      return true;
    }
    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return this.normalBounds;
    }
  }

  return {
    FakeWindow,
    nativeTheme: Object.assign(new Emitter(), { shouldUseDarkColors: false }),
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] },
    session: {
      fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }),
    },
    dialog: { showOpenDialog: vi.fn() },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: electron.FakeWindow,
  nativeTheme: electron.nativeTheme,
  screen: electron.screen,
  session: electron.session,
  dialog: electron.dialog,
}));

const { createControlWindow } = await import('../src/main/control-window.js');

const INDEX = 'C:\\app\\dist\\control\\index.html';

function setup(open: { section: ControlSection } | undefined = undefined) {
  const save = vi.fn((_bounds: ControlWindowBounds) => undefined);
  const note = vi.fn();
  const control = createControlWindow({
    indexPath: INDEX,
    preloadPath: 'C:\\app\\dist\\preload\\control.cjs',
    iconPath: 'C:\\app\\icon.png',
    bounds: { load: () => undefined, save },
    onMissingUi: vi.fn(),
    note,
    exists: () => true,
  });
  if (open === undefined) control.open();
  else control.open(open);
  const window = electron.FakeWindow.all.at(-1);
  if (window === undefined) throw new Error('a janela não foi criada');
  return { control, window, save, note };
}

/** The window's page is the control center's own local page, loaded. */
function pageLoaded(window: InstanceType<typeof electron.FakeWindow>): void {
  window.webContents.url = 'file:///C:/app/dist/control/index.html';
  window.webContents.loading = false;
}

beforeEach(() => {
  electron.FakeWindow.all.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('remembering where the window is', () => {
  it('saves the normal size and place after the window was moved or resized (debounced)', () => {
    const { window, save } = setup();
    window.emit('move');
    window.emit('resize');
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ x: 10, y: 20, width: 1180, height: 760, maximized: false });
  });

  it('remembers that it was maximized', () => {
    const { window, save } = setup();
    window.maximized = true;
    window.emit('maximize');
    expect(save).toHaveBeenLastCalledWith({ x: 10, y: 20, width: 1180, height: 760, maximized: true });
  });

  it('saves nothing while the window is minimized: Windows then reports a maximized window as not maximized and parks it off screen', () => {
    const { window, save } = setup();
    window.maximized = true;
    window.minimized = true;
    window.emit('move');
    window.emit('resize');
    vi.advanceTimersByTime(1_000);
    window.emit('maximize');
    window.emit('unmaximize');
    // Closing (hiding to the tray) a minimized window is a save too.
    window.emit('close', { preventDefault: vi.fn() });
    expect(save).not.toHaveBeenCalled();
  });

  it('saves again once it is back', () => {
    const { window, save } = setup();
    window.minimized = true;
    window.emit('move');
    vi.advanceTimersByTime(1_000);
    expect(save).not.toHaveBeenCalled();
    window.minimized = false;
    window.emit('restore');
    window.emit('move');
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('a renderer that died', () => {
  it('is reloaded the next time the window is opened, once', () => {
    const { control, window, note } = setup();
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(note).toHaveBeenCalledWith(expect.stringContaining('crashed'));
    // Nothing is reloaded behind the user's back: a renderer that dies at once would loop.
    expect(window.webContents.reload).not.toHaveBeenCalled();

    control.open();
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalled();
    expect(electron.FakeWindow.all).toHaveLength(1);

    control.open();
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it.each(['oom', 'abnormal-exit', 'killed', 'launch-failed', 'integrity-failure'])('is reloaded after %s', (reason) => {
    const { control, window } = setup();
    window.webContents.emit('render-process-gone', {}, { reason });
    control.open();
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
  });

  it('a renderer that ended cleanly needs nothing', () => {
    const { control, window } = setup();
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
    control.open();
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });

  it('a hidden window (closed to the tray) with a dead renderer is brought back reloaded', () => {
    const { control, window } = setup();
    window.visible = false;
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    control.open();
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });
});

describe('opening on a section (the tray item "Abrir sessões")', () => {
  it('a new window starts on that section: the page reads ?section= from its own URL', () => {
    const { window } = setup({ section: 'sessions' });
    expect(window.loadFile).toHaveBeenCalledWith(INDEX, { query: { section: 'sessions' } });
  });

  it('a new window without a section loads the plain page', () => {
    const { window } = setup();
    expect(window.loadFile).toHaveBeenCalledWith(INDEX, undefined);
  });

  it('an open window is shown and asked to go there', () => {
    const { control, window } = setup();
    pageLoaded(window);
    control.open({ section: 'sessions' });
    expect(window.webContents.send).toHaveBeenCalledWith('control:navigate', 'sessions');
    expect(window.show).toHaveBeenCalled();
    expect(electron.FakeWindow.all).toHaveLength(1);
  });

  it('a hidden window (closed to the tray) is brought back on that section', () => {
    const { control, window } = setup();
    pageLoaded(window);
    window.visible = false;
    control.open({ section: 'sessions' });
    expect(window.webContents.send).toHaveBeenCalledWith('control:navigate', 'sessions');
    expect(window.show).toHaveBeenCalled();
    expect(window.focus).toHaveBeenCalled();
  });

  it('a page that is still loading is told when it finishes, once', () => {
    const { control, window } = setup();
    window.webContents.loading = true;
    control.open({ section: 'sessions' });
    expect(window.webContents.send).not.toHaveBeenCalled();
    pageLoaded(window);
    window.webContents.emit('did-finish-load');
    window.webContents.emit('did-finish-load');
    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === 'control:navigate')).toEqual([['control:navigate', 'sessions']]);
  });

  it('opening with no section sends no navigation', () => {
    const { control, window } = setup();
    pageLoaded(window);
    control.open();
    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === 'control:navigate')).toEqual([]);
  });

  it('a window whose renderer died reloads on the section asked for', () => {
    const { control, window } = setup();
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    control.open({ section: 'sessions' });
    expect(window.loadFile).toHaveBeenLastCalledWith(INDEX, { query: { section: 'sessions' } });
    expect(window.webContents.reload).not.toHaveBeenCalled();
  });
});

describe('what the sessions view needs from the window', () => {
  it('reports the content area, and nothing while there is no window', () => {
    const unopened = createControlWindow({
      indexPath: INDEX,
      preloadPath: 'C:\app\dist\preload\control.cjs',
      iconPath: 'C:\app\icon.png',
      bounds: { load: () => undefined, save: vi.fn() },
      onMissingUi: vi.fn(),
      note: vi.fn(),
      exists: () => true,
    });
    expect(unopened.contentSize()).toBeNull();
    const { control, window } = setup();
    expect(control.contentSize()).toEqual({ width: 1180, height: 760 });
    window.contentBounds = { x: 0, y: 0, width: 940, height: 620 };
    expect(control.contentSize()).toEqual({ width: 940, height: 620 });
  });

  it('attaches and detaches a view on the window content, and gives the keyboard back to the page', () => {
    const { control, window } = setup();
    const view = {} as never;
    control.attachView(view);
    control.detachView(view);
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view);
    control.focusPage();
    expect(window.webContents.focus).toHaveBeenCalled();
  });

  it('says whether the window has the keyboard focus', () => {
    const { control, window } = setup();
    expect(control.isFocused()).toBe(true);
    window.isFocused = () => false;
    expect(control.isFocused()).toBe(false);
  });

  it('tells its listeners about every resize until they stop', () => {
    const { control, window } = setup();
    const listener = vi.fn();
    const stop = control.onResize(listener);
    window.emit('resize');
    window.emit('resize');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    window.emit('resize');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
