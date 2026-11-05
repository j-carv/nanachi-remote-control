import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleSlash,
  ClipboardPaste,
  Copy,
  FileDiff,
  GitBranch,
  type LucideIcon,
} from 'lucide-react';
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
import { shellIdFromTitle } from '../shells.js';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from '../terminal/fontSize.js';
import { lineInput } from '../terminal/input.js';
import { TERMINAL_KEYS, type TerminalKey } from '../terminal/keys.js';
import { useTerminal, type CopyResult, type PasteResult } from '../terminal/useTerminal.js';
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
  onRepair(): void;
}

/** Result of the last copy or paste, kept as a kind and written in the current language when shown. */
type Note = { action: 'copy'; result: CopyResult } | { action: 'paste'; result: PasteResult };

function noteText(note: Note, t: TFunction<'terminal'>): string {
  return note.action === 'copy' ? t(`copy.${note.result}`) : t(`paste.${note.result}`);
}

/** Setas da barra: ícone no lugar do caractere (o `label` de keys.ts fica para as teclas com texto). */
const KEY_ICON: Partial<Record<string, LucideIcon>> = {
  up: ArrowUp,
  down: ArrowDown,
  left: ArrowLeft,
  right: ArrowRight,
};

/** Texto do aviso de encerramento. `reload` vem do daemon quando ele recarrega; sem ele, o processo saiu sozinho. */
function closedText(exit: { exitCode: number | null; reason: 'reload' | null } | null, t: TFunction<'terminal'>): string {
  if (exit === null) return t('closed.plain');
  if (exit.reason === 'reload') return t('closed.reload');
  return exit.exitCode === null ? t('closed.noCode') : t('closed.code', { code: exit.exitCode });
}

/**
 * Sessão de terminal (PTY, inclusive o shell do workspace): o xterm ocupa o espaço sob o cabeçalho; embaixo,
 * os ajustes de fonte, a barra de teclas do celular que rola na horizontal e a linha de texto. A tela tem a altura
 * da janela e, com o teclado aberto, a área visível do iOS (useVisualViewport), para o rodapé não sumir atrás dele.
 */
export function TerminalScreen({
  machineName,
  workspace,
  session,
  api,
  connection,
  nav,
  onRepair,
}: TerminalScreenProps) {
  const { t } = useTranslation('terminal');
  const terminal = useTerminal({ api, connection, session });
  const current = terminal.session;
  const isShell = current.agent === 'shell';
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const agentLabel = agents.data?.find((agent) => agent.id === current.agent)?.label ?? current.agent;
  const viewport = useVisualViewport();
  const {
    requestFit,
    input,
    inputOpen,
    sticky,
    toggleSticky,
    paste,
    copySelection,
    fontSize,
    changeFontSize,
    scrolledUp,
    scrollToEnd,
  } = terminal;
  const [line, setLine] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<unknown>(null);

  // Teclado do iOS e rotação mudam a área visível: refaz o fit (com debounce no hook).
  useEffect(() => {
    requestFit();
  }, [viewport, requestFit]);

  function submitLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inputOpen) return;
    if (input(lineInput(line))) setLine('');
  }

  async function copy() {
    setNote({ action: 'copy', result: await copySelection() });
  }

  async function pasteClipboard() {
    setNote({ action: 'paste', result: await paste() });
  }

  function pressKey(key: TerminalKey) {
    const action = key.action;
    if (action.type === 'send') input(action.data);
    else if (action.type === 'sticky') toggleSticky(action.key);
    else void pasteClipboard();
  }

  /** Abre outro shell na mesma pasta, com o mesmo programa deste (se ainda existir no PC). */
  async function openNewTerminal() {
    setOpening(true);
    setOpenError(null);
    try {
      const wanted = shellIdFromTitle(current.title);
      const shells = await api.fetchShells();
      const shell = wanted !== null && shells.some((entry) => entry.id === wanted) ? wanted : undefined;
      const created = await api.createSession(
        shell === undefined ? { workspaceId: workspace.id, agent: 'shell' } : { workspaceId: workspace.id, agent: 'shell', shell },
      );
      nav.replace({ kind: 'chat', workspace, session: created });
    } catch (caught) {
      setOpenError(caught);
    } finally {
      setOpening(false);
    }
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
          actions={
            <>
              <SessionStatusPill status={current.status} kind="pty" />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('changes')}
                onClick={() => nav.push({ kind: 'changes', workspace, session: current })}
              >
                <FileDiff aria-hidden="true" />
              </Button>
            </>
          }
        />

        <ErrorNotice error={terminal.loadError} onRepair={onRepair} />
        <ErrorNotice error={openError} />

        {terminal.notice !== null && (
          <div role="status" data-slot="terminal-notice" className="flex items-center gap-3 rounded-lg bg-muted p-3 text-sm">
            <p className="min-w-0 flex-1 leading-5">{terminal.notice}</p>
            <Button variant="ghost" onClick={terminal.dismissNotice}>
              {t('dismiss')}
            </Button>
          </div>
        )}

        {closed && (
          <div role="status" data-slot="terminal-closed" className="flex flex-col gap-3 rounded-lg bg-muted p-4 text-sm">
            <p className="flex items-center gap-2 leading-5">
              <CircleSlash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              {closedText(terminal.exit, t)}
            </p>
            {isShell && (
              <Button size="wide" onClick={() => void openNewTerminal()} disabled={opening}>
                {opening ? t('opening') : t('openNew')}
              </Button>
            )}
          </div>
        )}

        {!terminal.loaded && terminal.loadError === null && (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        )}

        {/* Fundo escuro fixo nos dois temas, como o palco do xterm (THEME em terminal/options.ts). O botão fica fora
            do elemento do xterm: o React não divide os filhos com ele. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            data-slot="terminal-view"
            className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-[#0b0d12] py-1.5 pr-1 pl-2"
            ref={terminal.setContainer}
          />
          {scrolledUp && (
            <Button
              variant="outline"
              data-slot="terminal-scroll-end"
              className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-card shadow-lg"
              onClick={scrollToEnd}
            >
              <ArrowDown aria-hidden="true" />
              {t('scrollToEnd')}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="min-w-11 px-3"
            aria-label={t('fontSmaller')}
            disabled={fontSize <= MIN_FONT_SIZE}
            onClick={() => changeFontSize(fontSize - 1)}
          >
            A−
          </Button>
          <Button
            variant="secondary"
            className="min-w-11 px-3"
            aria-label={t('fontLarger')}
            disabled={fontSize >= MAX_FONT_SIZE}
            onClick={() => changeFontSize(fontSize + 1)}
          >
            A+
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" className="min-h-11 px-3" onClick={() => void copy()}>
            <Copy aria-hidden="true" />
            {t('copySelection')}
          </Button>
        </div>

        {note !== null && (
          <p className="text-sm text-muted-foreground" role="status">
            {noteText(note, t)}
          </p>
        )}

        <div
          role="toolbar"
          aria-label={t('keysLabel')}
          className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] wide:pointer-fine:hidden [&::-webkit-scrollbar]:hidden"
        >
          {TERMINAL_KEYS.map((key) => {
            const Icon = KEY_ICON[key.id];
            const pressed = key.action.type === 'sticky' && sticky[key.action.key];
            return (
              <Button
                key={key.id}
                type="button"
                variant={pressed ? 'default' : 'secondary'}
                data-slot="terminal-key"
                className="min-h-11 min-w-11 shrink-0 px-3 font-mono text-sm font-semibold"
                aria-label={key.ariaLabel}
                aria-pressed={key.action.type === 'sticky' ? pressed : undefined}
                disabled={!inputOpen}
                onClick={() => pressKey(key)}
              >
                {Icon !== undefined ? (
                  <Icon aria-hidden="true" />
                ) : key.id === 'paste' ? (
                  <ClipboardPaste aria-hidden="true" />
                ) : (
                  key.label
                )}
              </Button>
            );
          })}
        </div>

        <form className="flex items-center gap-2 wide:pointer-fine:hidden" onSubmit={submitLine}>
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
