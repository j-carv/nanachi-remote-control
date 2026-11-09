import { useEffect, useState, type FormEvent } from 'react';
import { CircleSlash, GitBranch } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { useVisualViewport } from '../components/useVisualViewport.js';
import type { Connection } from '../connection.js';
import type { Navigator } from '../navigation.js';
import { useLayout } from '../wide/layoutContext.js';
import { sessionTitle } from '../sessionText.js';
import { lineInput } from '../terminal/input.js';
import { useTerminal } from '../terminal/useTerminal.js';
import { useAsync } from '../useAsync.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface TerminalScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  connection: Connection | undefined;
  nav: Navigator;
}

/** Texto do aviso de encerramento. `reload` vem do daemon quando ele recarrega; sem ele, o processo saiu sozinho. */
function closedText(exit: { exitCode: number | null; reason: 'reload' | null } | null, t: TFunction<'terminal'>): string {
  if (exit === null) return t('closed.plain');
  if (exit.reason === 'reload') return t('closed.reload');
  return exit.exitCode === null ? t('closed.noCode') : t('closed.code', { code: exit.exitCode });
}

/**
 * PTY session screen (including the workspace shell). The xterm fills the space under the header; below it there is
 * only the line field with Send, on phones and PCs alike. The screen is the window's height and, with the iOS keyboard
 * open, the visible area (useVisualViewport), so the footer does not hide behind the keyboard.
 */
export function TerminalScreen({ machineName, workspace, session, api, connection, nav }: TerminalScreenProps) {
  const { t } = useTranslation('terminal');
  const terminal = useTerminal({ api, connection, session });
  const current = terminal.session;
  const isShell = current.agent === 'shell';
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const agentLabel = agents.data?.find((agent) => agent.id === current.agent)?.label ?? current.agent;
  const viewport = useVisualViewport();
  const { requestFit, input, inputOpen, scrollToEnd } = terminal;
  const [line, setLine] = useState('');

  // Teclado do iOS e rotação mudam a área visível: refaz o fit (com debounce no hook).
  useEffect(() => {
    requestFit();
  }, [viewport, requestFit]);

  function submitLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inputOpen) return;
    if (!input(lineInput(line))) return;
    setLine('');
    // The reply comes at the bottom; with the history scrolled up it would stay out of view, and there is no button to go back.
    scrollToEnd();
  }

  // Next to the list pane the terminal fills its pane, so the keyboard-sized box of the phone does not apply.
  const embedded = useLayout() !== 'phone';
  const boxStyle = viewport === null || embedded ? undefined : { top: viewport.top, height: viewport.height };
  const closed = terminal.loaded && !inputOpen;

  return (
    <div
      className="fixed inset-x-0 top-0 bottom-0 flex justify-center bg-background text-foreground wide:absolute wide:inset-0"
      style={boxStyle}
    >
      <div className="flex h-full w-full max-w-[560px] min-h-0 flex-col gap-3 pt-[calc(env(safe-area-inset-top,0px)+12px)] pr-[calc(env(safe-area-inset-right,0px)+16px)] pb-[calc(env(safe-area-inset-bottom,0px)+8px)] pl-[calc(env(safe-area-inset-left,0px)+16px)] wide:max-w-none wide:px-5 wide:pt-4 wide:pb-4">
        <ScreenHeader
          title={sessionTitle(current, isShell ? 'Terminal' : agentLabel)}
          subtitle={`${workspace.name} · ${machineName}`}
          meta={
            current.worktree === null ? null : (
              <Badge variant="outline" className="h-7 max-w-full gap-1.5 self-start px-2.5 font-mono text-xs text-foreground">
                <GitBranch aria-hidden="true" />
                <span className="truncate">{current.worktree.branch}</span>
              </Badge>
            )
          }
          onBack={() => nav.back()}
          actions={<SessionStatusPill status={current.status} kind="pty" />}
        />

        <ErrorNotice error={terminal.loadError} />

        {terminal.notice !== null && (
          <p role="status" data-slot="terminal-notice" className="rounded-lg bg-muted p-3 text-sm leading-5">
            {terminal.notice}
          </p>
        )}

        {closed && (
          <p role="status" data-slot="terminal-closed" className="flex items-center gap-2 rounded-lg bg-muted p-4 text-sm leading-5">
            <CircleSlash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {closedText(terminal.exit, t)}
          </p>
        )}

        {!terminal.loaded && terminal.loadError === null && (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )}

        {/* Fundo escuro fixo nos dois temas, como o palco do xterm (THEME em terminal/options.ts). */}
        <div
          data-slot="terminal-view"
          className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-[#0b0d12] py-1.5 pr-1 pl-2"
          ref={terminal.setContainer}
        />

        <form className="flex items-center gap-2" onSubmit={submitLine}>
          <Input
            type="text"
            data-slot="terminal-line"
            className="flex-1"
            value={line}
            placeholder={inputOpen ? t('linePlaceholder') : t('closed.plain')}
            disabled={!inputOpen}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            onChange={(event) => setLine(event.target.value)}
          />
          <Button type="submit" disabled={!inputOpen}>
            {t('send')}
          </Button>
        </form>
      </div>
    </div>
  );
}
