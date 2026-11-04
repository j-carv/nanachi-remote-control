import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { GitBranch, Paperclip } from '@phosphor-icons/react';
import type { AvailableCommand, Session, SessionStatus, Workspace } from '@nanachi/shared';
import { splitOptions } from '../agentConfig.js';
import { ApiError, type ApiClient } from '../api.js';
import { ConfigControls, ConfigSelect } from '../components/ConfigControls.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import { OverflowMenu } from '../components/OverflowMenu.js';
import { RemoveSessionSheet } from '../components/RemoveSessionSheet.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { useVisualViewport } from '../components/useVisualViewport.js';
import type { Connection } from '../connection.js';
import { AttachmentDrafts } from '../chat/AttachmentDrafts.js';
import { ATTACHMENT_LIMIT, uploadFiles } from '../chat/attachments.js';
import { ChatItemView } from '../chat/ChatItemView.js';
import { insertCommand, slashQuery } from '../chat/commands.js';
import { SlashMenu } from '../chat/SlashMenu.js';
import { isInputEnabled, isResumable } from '../chat/controls.js';
import { useAttachmentDrafts } from '../chat/useAttachmentDrafts.js';
import { useChat } from '../chat/useChat.js';
import { useAsync } from '../useAsync.js';
import { PermissionCard } from '../chat/PermissionCard.js';
import {
  WINDOW_INITIAL,
  WINDOW_STEP,
  earlierFloor,
  initialFloor,
  isNearBottom,
  unseenSince,
} from '../chat/scrollFollow.js';
import type { StorageLike } from '../machines.js';
import type { Navigator } from '../navigation.js';

interface ChatScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  connection: Connection | undefined;
  storage: StorageLike;
  nav: Navigator;
  onRepair(): void;
}

/** Texto do indicador acima do input, por status. `idle` não mostra indicador. */
const WORKING_TEXT: Partial<Record<SessionStatus, string>> = {
  starting: 'Iniciando o agente…',
  running: 'Trabalhando…',
  awaiting_permission: 'Aguardando a sua permissão',
  stopped: 'Sessão encerrada',
  error: 'A sessão deu erro',
};

const PLACEHOLDER: Record<SessionStatus, string> = {
  starting: 'Aguarde o agente iniciar…',
  idle: 'Escreva uma mensagem',
  running: 'Aguarde o agente terminar…',
  awaiting_permission: 'Responda à permissão',
  stopped: 'Sessão encerrada',
  error: 'Sessão com erro',
};

/** Posição da conversa por sessão, guardada enquanto o app roda: voltar ao chat retoma de onde o usuário saiu. */
interface SavedPosition {
  floor: number;
  top: number;
  atBottom: boolean;
}
const savedPositions = new Map<string, SavedPosition>();

/** Abaixo desta distância do topo, "Carregar anteriores" entra sozinho. */
const LOAD_EARLIER_PX = 120;

export function ChatScreen({
  machineName,
  workspace,
  session,
  api,
  connection,
  storage,
  nav,
  onRepair,
}: ChatScreenProps) {
  const controller = useChat({ api, connection, storage, session });
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const { chat } = controller;
  const current = controller.session;
  const viewport = useVisualViewport();
  const { primary, extra } = splitOptions(controller.configOptions);

  const [extraOpen, setExtraOpen] = useState(false);
  const [draft, setDraft] = useState('');
  /** Posição do cursor no composer: o menu de comandos abre quando o texto até aqui é `/busca`. */
  const [caret, setCaret] = useState(0);
  /** Menu aberto pelo botão `/` (com campo de busca próprio), em vez de pelo texto. */
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** Cursor a aplicar depois que o comando entrou no texto (o React ainda não atualizou o campo). */
  const pendingCaret = useRef<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const attachments = useAttachmentDrafts();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [sendError, setSendError] = useState<unknown>(null);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  /** Segue o fim enquanto o usuário não subiu a conversa (tolerância em scrollFollow.ts). */
  const stick = useRef(true);
  /** Primeiro item renderizado (janela da conversa). Null até o histórico carregar. */
  const [floor, setFloor] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** Quantos itens existiam quando o usuário saiu do fim: a contagem do botão é o que chegou depois. */
  const baseline = useRef(0);
  /** Item visível antes de carregar anteriores: depois da mudança a tela volta a mostrar o mesmo ponto. */
  const anchor = useRef<{ element: Element; top: number } | null>(null);
  const pendingRestore = useRef<SavedPosition | undefined>(savedPositions.get(current.id));
  const permissionCount = useRef(0);
  /** Posição vista pelo último evento de rolagem (ver settleUserScroll). */
  const seenTop = useRef(0);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);
  /** Sair da sessão uma vez só: remover pelo app e o broadcast session_removed chegam juntos. */
  const leaving = useRef(false);

  function leave() {
    if (leaving.current) return;
    leaving.current = true;
    nav.back();
  }

  useEffect(
    () =>
      connection?.onMessage((message) => {
        if (message.type === 'session_removed' && message.sessionId === current.id) leave();
      }),
    [connection, current.id],
  );

  async function removeFromApp() {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.deleteSession(current.id, { forget: true });
      leave();
    } catch (caught) {
      setRemoveError(caught);
    } finally {
      setRemoveBusy(false);
    }
  }

  // Primeiro item renderizado: já na renderização que traz o histórico (sem pintar a conversa inteira antes),
  // ou a janela salva ao voltar ao chat. Congela em `floor` na primeira vez; daí em diante só muda por "Carregar anteriores".
  const restored = pendingRestore.current;
  const start =
    floor ?? (controller.loaded ? (restored === undefined ? initialFloor(chat.items.length, WINDOW_INITIAL) : Math.min(restored.floor, chat.items.length)) : 0);

  useEffect(() => {
    if (controller.loaded && floor === null) setFloor(start);
  }, [controller.loaded, floor, start]);

  // Antes da pintura: ancora o item visível depois de carregar anteriores, restaura a posição salva ou gruda no fim.
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    settleUserScroll(timeline);
    if (chat.permissions.length > permissionCount.current) stick.current = true;
    permissionCount.current = chat.permissions.length;

    const pendingAnchor = anchor.current;
    const saved = pendingRestore.current;
    if (pendingAnchor !== null) {
      anchor.current = null;
      timeline.scrollTop += pendingAnchor.element.getBoundingClientRect().top - pendingAnchor.top;
    } else if (controller.loaded && saved !== undefined) {
      pendingRestore.current = undefined;
      stick.current = saved.atBottom;
      timeline.scrollTop = saved.atBottom ? timeline.scrollHeight : saved.top;
      setAtBottom(saved.atBottom);
    } else if (stick.current) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    seenTop.current = timeline.scrollTop;
  }, [controller.loaded, floor, chat.items, chat.permissions]);

  // Conteúdo que muda de altura sem chegar item novo (imagem carregando, bloco expandido, teclado abrindo).
  useEffect(() => {
    const timeline = timelineRef.current;
    const feed = feedRef.current;
    if (timeline === null || feed === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      settleUserScroll(timeline);
      if (stick.current) timeline.scrollTop = timeline.scrollHeight;
      seenTop.current = timeline.scrollTop;
    });
    observer.observe(timeline);
    observer.observe(feed);
    return () => observer.disconnect();
  }, []);

  function loadEarlier() {
    const timeline = timelineRef.current;
    const feed = feedRef.current;
    if (timeline === null || feed === null || start === 0) return;
    const top = timeline.getBoundingClientRect().top;
    const element = Array.from(feed.children).find((child) => child.getBoundingClientRect().bottom > top + 1);
    anchor.current = element === undefined ? null : { element, top: element.getBoundingClientRect().top };
    setFloor(earlierFloor(start, WINDOW_STEP));
  }

  function jumpToEnd() {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    stick.current = true;
    setAtBottom(true);
    timeline.scrollTop = timeline.scrollHeight;
    seenTop.current = timeline.scrollTop;
  }

  function onTimelineScroll() {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    seenTop.current = timeline.scrollTop;
    const near = isNearBottom(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight);
    stick.current = near;
    if (near !== atBottom) {
      setAtBottom(near);
      if (!near) baseline.current = chat.items.length;
    }
    if (floor !== null) {
      savedPositions.set(current.id, { floor, top: timeline.scrollTop, atBottom: near });
      if (floor > 0 && timeline.scrollTop < LOAD_EARLIER_PX) loadEarlier();
    }
  }

  /**
   * Rolagem que o evento ainda não reportou (o toque ou a roda já mudou a posição, mas o `scroll` não chegou) vale
   * antes de qualquer ajuste automático: senão o fim sobrescreve a posição que o usuário acabou de escolher.
   */
  function settleUserScroll(timeline: HTMLDivElement) {
    if (timeline.scrollTop !== seenTop.current) {
      stick.current = isNearBottom(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight);
    }
  }

  /** Sobe os anexos (um a um, com progresso) e depois manda o prompt citando os arquivos. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chat.status !== 'idle' || sending) return;

    const text = draft;
    if (attachments.drafts.length === 0) {
      if (controller.sendPrompt(text)) {
        setDraft('');
        stick.current = true;
      }
      return;
    }

    setSending(true);
    setSendError(null);
    setProgress(0);
    try {
      const uploaded = await uploadFiles(
        attachments.drafts.map((draftItem) => draftItem.file),
        (file, onProgress) => controller.uploadAttachment(file, onProgress),
        setProgress,
      );
      // Sem conexão, o send já mostra o aviso; os anexos continuam na prévia para tentar de novo.
      if (controller.sendPrompt(text, uploaded)) {
        setDraft('');
        attachments.clear();
        setAttachNotice(null);
        stick.current = true;
      }
    } catch (caught) {
      setSendError(caught);
    } finally {
      setSending(false);
      setProgress(null);
    }
  }

  // Depois de inserir um comando: o campo já tem o texto novo, então o cursor vai para o fim do comando.
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null || textarea.current === null) return;
    pendingCaret.current = null;
    textarea.current.setSelectionRange(target, target);
  }, [draft]);

  /** Insere o comando e devolve o foco ao campo (o clique é gesto do usuário, então o teclado continua aberto). */
  function pickCommand(command: AvailableCommand) {
    const next = insertCommand(draft, caret, command.name, commandsOpen ? 'prefix' : 'typed');
    setDraft(next.text);
    setCaret(next.caret);
    setCommandsOpen(false);
    setCommandQuery('');
    pendingCaret.current = next.caret;
    textarea.current?.focus();
  }

  function onFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (picked.length === 0) return;
    const rejected = attachments.add(picked);
    setAttachNotice(
      rejected > 0 ? `Limite de ${ATTACHMENT_LIMIT} anexos por mensagem.` : null,
    );
  }

  const resumable = isResumable(chat.status);
  const working = controller.resuming ? 'Retomando…' : WORKING_TEXT[chat.status];
  const placeholder = controller.resuming ? 'Retomando a sessão…' : PLACEHOLDER[chat.status];
  const inputEnabled = isInputEnabled(chat.status);
  const notResumable =
    controller.resumeError instanceof ApiError && controller.resumeError.kind === 'not_resumable';
  const visibleItems = chat.items.slice(start);
  const unseen = unseenSince(baseline.current, chat.items.length);
  const hasContent = draft.trim() !== '' || attachments.drafts.length > 0;
  const canSend = chat.status === 'idle' && hasContent && !sending;
  // Menu: aberto pelo botão, ou pelo texto `/busca` no começo do composer. Só com o campo habilitado.
  const typedQuery = inputEnabled ? slashQuery(draft, caret) : undefined;
  const menuQuery = !inputEnabled ? undefined : commandsOpen ? commandQuery : typedQuery;
  const boxStyle = viewport === null ? undefined : { top: viewport.top, height: viewport.height };

  return (
    <div className="chat-screen" style={boxStyle}>
      <div className="chat-inner">
        <ScreenHeader
          title={current.title}
          subtitle={`${workspace.name} · ${machineName}`}
          meta={
            current.worktree === null ? null : (
              <span className="chip chip-branch">
                <GitBranch size={14} weight="bold" aria-hidden="true" />
                {current.worktree.branch}
              </span>
            )
          }
          onBack={() => nav.back()}
          actions={
            <>
              <SessionStatusPill status={chat.status} />
              <button
                type="button"
                className="button secondary header-button"
                onClick={() => nav.push({ kind: 'changes', workspace, session: current })}
              >
                Alterações
              </button>
              <OverflowMenu
                label="Mais ações da sessão"
                items={[{ label: 'Remover do app', tone: 'danger', onSelect: () => setRemoving(true) }]}
              />
            </>
          }
        />

        {primary.length > 0 && (
          <div className="config-bar">
            {primary.map((control) => (
              <ConfigSelect
                key={control.option.id}
                label={control.label}
                option={control.option}
                onChange={(value) => controller.setConfig(control.option.id, value)}
              />
            ))}
            {extra.length > 0 && (
              <button
                type="button"
                className="button secondary config-more"
                aria-expanded={extraOpen}
                aria-label="Mais opções"
                onClick={() => setExtraOpen((open) => !open)}
              >
                Mais
              </button>
            )}
          </div>
        )}

        {extraOpen && extra.length > 0 && (
          <section className="card config-extra" aria-label="Mais opções">
            <h2 className="section-title">Mais opções</h2>
            <ConfigControls options={extra} onChange={(id, value) => controller.setConfig(id, value)} />
          </section>
        )}

        <ErrorNotice error={controller.loadError} onRepair={onRepair} />
        <ErrorNotice
          error={controller.resumeError}
          action={notResumable ? { label: '+ Nova sessão', onClick: () => setSheetOpen(true) } : undefined}
        />
        <ErrorNotice error={sendError} onRepair={onRepair} />

        {controller.notice !== null && (
          <div className="notice" role="status">
            <p>{controller.notice}</p>
            <button type="button" className="button ghost" onClick={controller.dismissNotice}>
              OK
            </button>
          </div>
        )}

        <div className="chat-body">
          <div className="chat-timeline" ref={timelineRef} onScroll={onTimelineScroll}>
            {!controller.loaded && controller.loadError === null && (
              <p className="muted">Carregando conversa…</p>
            )}
            {start > 0 && (
              <button type="button" className="button secondary load-earlier" onClick={loadEarlier}>
                Carregar anteriores
              </button>
            )}
            <div className="chat-feed" ref={feedRef}>
              {visibleItems.map((item) => (
                <ChatItemView key={item.id} item={item} api={api} />
              ))}
            </div>
            {chat.permissions.map((request) => (
              <PermissionCard
                key={request.requestId}
                api={api}
                request={request}
                onRespond={(optionId) => controller.respond(request.requestId, optionId)}
              />
            ))}
          </div>
          {!atBottom && (
            <button type="button" className="jump-bottom" onClick={jumpToEnd}>
              Ir para o fim
              {unseen > 0 && <span className="jump-count">{unseen}</span>}
            </button>
          )}
        </div>

        {working !== undefined && (
          <div className="working-bar" role="status">
            <span
              className={chat.status === 'running' || controller.resuming ? 'spinner' : 'dot dot-connecting'}
              aria-hidden="true"
            />
            <span className="working-text">{working}</span>
            {chat.status === 'running' && (
              <button type="button" className="button danger" onClick={() => controller.cancel()}>
                Parar
              </button>
            )}
            {resumable && !controller.resuming && (
              <button type="button" className="button primary" onClick={() => void controller.resume()}>
                Retomar
              </button>
            )}
          </div>
        )}

        {(attachments.drafts.length > 0 || attachNotice !== null) && (
          <div className="composer-attachments">
            <AttachmentDrafts drafts={attachments.drafts} onRemove={attachments.remove} />
            {attachNotice !== null && (
              <p className="muted small" role="status">
                {attachNotice}
              </p>
            )}
          </div>
        )}

        {progress !== null && (
          <div className="upload-bar" role="status">
            <progress className="upload-progress" max={1} value={progress} />
            <span className="muted small">Enviando… {Math.round(progress * 100)}%</span>
          </div>
        )}

        {menuQuery !== undefined && (
          <SlashMenu
            commands={controller.commands}
            query={menuQuery}
            search={
              commandsOpen
                ? { onChange: setCommandQuery, onClose: () => setCommandsOpen(false) }
                : undefined
            }
            onPick={pickCommand}
          />
        )}

        <form className="chat-input" onSubmit={(event) => void submit(event)}>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={onFilesPicked}
          />
          <button
            type="button"
            className="icon-button attach-button"
            aria-label="Anexar arquivo"
            disabled={!inputEnabled || sending}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={22} weight="regular" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button command-button"
            aria-label="Comandos do agente"
            aria-expanded={commandsOpen}
            disabled={!inputEnabled || sending}
            onClick={() => {
              setCommandQuery('');
              setCommandsOpen((open) => !open);
            }}
          >
            <span className="command-glyph" aria-hidden="true">
              /
            </span>
          </button>
          <textarea
            ref={textarea}
            className="chat-textarea"
            rows={1}
            value={draft}
            placeholder={placeholder}
            disabled={!inputEnabled}
            onChange={(event) => {
              setDraft(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          />
          <button type="submit" className="button primary" disabled={!canSend}>
            {sending ? 'Enviando…' : 'Enviar'}
          </button>
        </form>

        {removing && (
          <RemoveSessionSheet
            agentLabel={agents.data?.find((agent) => agent.id === current.agent)?.label ?? current.agent}
            status={chat.status}
            busy={removeBusy}
            error={removeError}
            onCancel={() => {
              setRemoving(false);
              setRemoveError(null);
            }}
            onConfirm={() => void removeFromApp()}
          />
        )}

        {sheetOpen && (
          <NewSessionSheet
            api={api}
            storage={storage}
            workspace={workspace}
            initialAgentId={current.agent}
            onClose={() => setSheetOpen(false)}
            onCreated={(next) => {
              setSheetOpen(false);
              nav.push({ kind: 'chat', workspace, session: next });
            }}
          />
        )}
      </div>
    </div>
  );
}
