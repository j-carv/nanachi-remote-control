import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { WindowState } from '../../common/control-api.js';
import type { DaemonStatus } from '../../common/types.js';
import { daemonSummary } from '../lib/status.js';
import { useApi } from '../state/api.js';
import { cx } from '../ui/cx.js';
import { StatusDot } from '../ui/StatusDot.js';
import { TONE_TEXT } from '../ui/tone.js';
import { Tooltip } from '../ui/Tooltip.js';

export interface TitleBarViewProps {
  machineName: string | null;
  daemon: DaemonStatus | null;
  windowState: WindowState;
  /** The tooltips are the browser's own `title`: on Sessões a portal below the bar would be painted under the PWA view. */
  nativeTips?: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  onOpenStatus: () => void;
}

function Separator() {
  return <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />;
}

interface WindowButtonProps {
  label: string;
  tip: string;
  native: boolean;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}

function WindowButton({ label, tip, native, onClick, danger = false, children }: WindowButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      title={native ? tip : undefined}
      onClick={onClick}
      className={cx(
        'app-no-drag focus-inset grid h-10 w-[46px] place-items-center text-foreground transition-colors duration-100 group-data-[focused=false]:text-muted-foreground [&_svg]:size-4',
        danger ? 'hover:bg-destructive hover:text-destructive-foreground active:bg-destructive/85' : 'hover:bg-accent active:bg-accent/70',
      )}
    >
      {children}
    </button>
  );
  if (native) return button;
  return (
    <Tooltip label={tip} side="bottom" align="end">
      {button}
    </Tooltip>
  );
}

/** The 40 px title bar drawn by Nanachi: identity and daemon status on the left, the three window buttons on the right. */
export function TitleBarView({ machineName, daemon, windowState, nativeTips = false, onMinimize, onToggleMaximize, onClose, onOpenStatus }: TitleBarViewProps) {
  const { t } = useTranslation();
  const summary = daemon ? daemonSummary(daemon, t) : null;
  const restoreOrMaximize = windowState.maximized ? t('shell.titleBar.restore') : t('shell.titleBar.maximize');
  return (
    <header
      data-focused={windowState.focused}
      className="app-drag group flex h-10 shrink-0 items-center border-b border-border bg-chrome text-[13px] select-none"
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest('button')) return;
        onToggleMaximize();
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5 pl-3.5">
        <img src="./icon.png" alt="" draggable={false} className="size-[18px] shrink-0 rounded-[4px] group-data-[focused=false]:opacity-70" />
        <span className="font-semibold text-foreground group-data-[focused=false]:text-muted-foreground">Nanachi</span>
        {machineName ? (
          <>
            <Separator />
            <span className="truncate text-muted-foreground">{machineName}</span>
          </>
        ) : null}
        {summary ? (
          <button
            type="button"
            onClick={onOpenStatus}
            aria-label={t('shell.titleBar.daemonButton', { status: summary.word })}
            className="app-no-drag -ml-0.5 flex h-7 items-center gap-1.5 rounded-md px-2 hover:bg-accent"
          >
            <StatusDot tone={summary.tone} pulse={summary.pulse} />
            <span className={cx('font-medium', TONE_TEXT[summary.tone])}>{summary.word}</span>
          </button>
        ) : null}
      </div>
      <div className="ml-auto flex h-full">
        <WindowButton label={t('shell.titleBar.minimize')} tip={t('shell.titleBar.minimize')} native={nativeTips} onClick={onMinimize}>
          <Minus strokeWidth={1.5} aria-hidden="true" />
        </WindowButton>
        <WindowButton label={restoreOrMaximize} tip={restoreOrMaximize} native={nativeTips} onClick={onToggleMaximize}>
          {windowState.maximized ? <Copy strokeWidth={1.5} className="-scale-x-100" aria-hidden="true" /> : <Square strokeWidth={1.5} className="!size-3.5" aria-hidden="true" />}
        </WindowButton>
        <WindowButton label={t('shell.titleBar.close')} tip={t('shell.titleBar.closeTip')} native={nativeTips} danger onClick={onClose}>
          <X strokeWidth={1.5} aria-hidden="true" />
        </WindowButton>
      </div>
    </header>
  );
}

/** Connects the title bar to the window API: the window state is read once and then followed. */
export function TitleBar({ machineName, daemon, nativeTips, onOpenStatus }: { machineName: string | null; daemon: DaemonStatus | null; nativeTips: boolean; onOpenStatus: () => void }) {
  const api = useApi();
  const [windowState, setWindowState] = useState<WindowState>({ maximized: false, focused: true });

  useEffect(() => {
    let active = true;
    api.window
      .state()
      .then((state) => {
        if (active) setWindowState(state);
      })
      .catch(() => undefined);
    const off = api.window.onState(setWindowState);
    return () => {
      active = false;
      off();
    };
  }, [api]);

  return (
    <TitleBarView
      machineName={machineName}
      daemon={daemon}
      windowState={windowState}
      nativeTips={nativeTips}
      onMinimize={() => void api.window.minimize()}
      onToggleMaximize={() => void api.window.toggleMaximize().then(setWindowState, () => undefined)}
      onClose={() => void api.window.close()}
      onOpenStatus={onOpenStatus}
    />
  );
}
