import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDown,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  FolderTree,
  Gauge,
  GitCompare,
  Layers,
  LoaderCircle,
  Paperclip,
  Repeat,
  Repeat1,
  SendHorizontal,
  Settings2,
  SlidersHorizontal,
  SquareSlash,
  SquareTerminal,
} from 'lucide-react';
import type { AvailableCommand, LoopRequest, Session, SessionStatus, Workspace } from '@nanachi/shared';
import { splitOptions } from '../agentConfig.js';
import { accountChangeLocked, accountSelectorFor, sessionAccount, sessionAccountInfo } from '../agentAccounts.js';
import { loadAccountsForSession } from '../agentAccountsCache.js';
import { ApiError, type ApiClient } from '../api.js';
import { AccountSelect } from '../components/AccountSelect.js';
import { ConfigControls, ConfigSelect } from '../components/ConfigControls.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ImageCropDialog } from '../components/ImageCropDialog.js';
import { useCssHeight } from '../components/useCssHeight.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import { ActionSheet, ActionSheetButton, type ActionSheetItem } from '../components/ActionSheet.js';
import { RemoveSessionSheet } from '../components/RemoveSessionSheet.js';
import { ShellSheet } from '../components/ShellSheet.js';
import { UsageDrawer } from '../components/UsageDrawer.js';
import { ListGroup, SectionHeading } from '../components/ListGroup.js';
import { StatusDot, type StatusTone } from '../components/StatusDot.js';
import { useVisualViewport } from '../components/useVisualViewport.js';
import type { Connection } from '../connection.js';
import { AttachmentDrafts } from '../chat/AttachmentDrafts.js';
import { ChatAttachContext } from '../chat/attachContext.js';
import { ATTACHMENT_LIMIT, uploadFiles } from '../chat/attachments.js';
import { ChatItemView } from '../chat/ChatItemView.js';
import { BackgroundDrawer } from '../chat/BackgroundDrawer.js';
import { RunningDots } from '../chat/RunningIndicator.js';
import { arrivedLive, historyOf, type HistoryIds } from '../chat/liveItems.js';
import { LoopChip } from '../chat/LoopChip.js';
import { LoopSheet } from '../chat/LoopSheet.js';
import { loopCommandFor } from '../chat/loopCommand.js';
import { useMediaQuery } from '../chat/useMediaQuery.js';
import { describeLoopError, describeSessionAccountError } from '../errorMessages.js';
import { ITEM_FRAME_CLASS } from '../chat/itemFrame.js';
import {
  backgroundChipCount,
  backgroundEntries,
  isActiveStatus,
  type BackgroundView,
} from '../chat/background.js';
import { nestItems, type ChatNode } from '../chat/nesting.js';
import { IDLE_PROMPT_CURSOR, promptHistoryOf, recallNewer, recallOlder, type PromptCursor, type PromptStep } from '../chat/promptHistory.js';
import {
  bareCommandName,
  commandForEnter,
  commandSheetFor,
  configSheetChoices,
  insertCommand,
  nativePickerFor,
  slashQuery,
  type CommandSheet,
} from '../chat/commands.js';
import { SlashMenu } from '../chat/SlashMenu.js';
import { acceptsPrompt, isInputEnabled, isResumable } from '../chat/controls.js';
import { useAttachmentDrafts, type DraftAttachment } from '../chat/useAttachmentDrafts.js';
import { useChat } from '../chat/useChat.js';
import { allowsSidePane, ENTER_SENDS_QUERY, enterSends } from '../wide/layout.js';
import { useBackAffordance, useLayout } from '../wide/layoutContext.js';
import { displaySessionTitle, sessionStatusText, sessionTitle } from '../sessionText.js';
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
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { useReloadGuard } from '@/updates/reloadGuard';

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

/** Cor do ponto de status no cabeçalho: as mesmas do SessionStatusPill da lista. */
const STATUS_TONE: Record<SessionStatus, StatusTone> = {
  starting: 'muted',
  idle: 'muted',
  running: 'running',
  awaiting_permission: 'attention',
  stopped: 'muted',
  error: 'danger',
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
  const { t } = useTranslation('chat');
  const { t: tw } = useTranslation('wide');
  const controller = useChat({ api, connection, storage, session });
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const { chat } = controller;
  const current = controller.session;
  const viewport = useVisualViewport();
  const { primary, extra } = splitOptions(controller.configOptions);
  const agentLabel = agents.data?.find((agent) => agent.id === current.agent)?.label ?? current.agent;

  const [configOpen, setConfigOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  /**
   * The accounts are read the first time a sheet that needs them opens (the daemon checks each login: not on every
   * chat). The list is shared per machine (agentAccountsCache.ts), and a terminal or an agent that is known to have no
   * accounts never asks.
   */
  const [accountsWanted, setAccountsWanted] = useState(false);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<unknown>(null);
  useEffect(() => {
    if (configOpen || usageOpen) setAccountsWanted(true);
  }, [configOpen, usageOpen]);
  // A failed switch must not outlive the sheet: reopening it starts clean.
  useEffect(() => {
    if (configOpen) setAccountError(null);
  }, [configOpen]);
  const accounts = useAsync(
    async () =>
      accountsWanted ? await loadAccountsForSession(api, { kind: current.kind, agent: current.agent, accountId: current.accountId }) : null,
    [api, accountsWanted, current.kind, current.agent, current.accountId],
  );
  const accountSelector = current.kind === 'acp' ? accountSelectorFor(accounts.data, current.agent) : null;
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  const [loopOpen, setLoopOpen] = useState(false);
  /** Short Loop mode notice ("Loop iniciado", or why a malformed `/loop` was refused). */
  const [loopNotice, setLoopNotice] = useState<string | null>(null);
  /**
   * Narrow screens (below 400 px): Uso do agente and Alterações leave the header for the "…" menu, so the title and
   * the new Modo Loop button fit. Wider screens keep the header as it was.
   */
  const compactHeader = useMediaQuery('(max-width: 399px)');
  // Wide screens: the chat sits in the right pane (not over the whole window); from 1280 px it can open files, changes
  // and a terminal in a third pane. Enter sends only for a mouse and keyboard (a touch screen keeps Enter as a new line).
  const layout = useLayout();
  const embedded = layout !== 'phone';
  const sidePane = allowsSidePane(layout);
  const backAffordance = useBackAffordance();
  const enterToSend = useMediaQuery(ENTER_SENDS_QUERY);
  const [shellOpen, setShellOpen] = useState(false);
  /** A tooltip for the icon buttons of the header: a pointer has no other way to read them. */
  const tip = (label: string): string | undefined => (embedded ? label : undefined);
  const loopActive = controller.loop !== null && controller.loop.state !== 'stopped';
  /** Item the header chip asked to show. The effect below scrolls to it once it is rendered. */
  const [revealRequest, setRevealRequest] = useState<{ id: string } | null>(null);
  const [draft, setDraft] = useState('');
  /** Posição do cursor no composer: o menu de comandos abre quando o texto até aqui é `/busca`. */
  const [caret, setCaret] = useState(0);
  /** Menu aberto pelo botão `/` (com campo de busca próprio), em vez de pelo texto. */
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  /** Folha aberta por um comando: seletor nativo (opção da sessão) ou subcomandos do hint. */
  const [commandSheet, setCommandSheet] = useState<CommandSheet | null>(null);
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
  /** Items already in the conversation when its history appeared. Only items that arrive later enter with motion (chat/liveItems.ts). */
  const [history, setHistory] = useState<HistoryIds | null>(null);
  /** Quantos itens existiam quando o usuário saiu do fim: a contagem do botão é o que chegou depois. */
  const baseline = useRef(0);
  /** A smooth "jump to end" is running: its scroll events do not count as the user leaving the end. */
  const jumping = useRef(false);
  /** User-requested scrolls are smooth; with the system's reduced motion setting they are instant. */
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  /** Number of sends. The send button is keyed by it, so each send pops the button once. */
  const [sends, setSends] = useState(0);
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
  /** Posição nas setas do histórico de prompts. Volta ao rascunho quando a mensagem é enviada. */
  const [historyCursor, setHistoryCursor] = useState<PromptCursor>(IDLE_PROMPT_CURSOR);
  const [composerFocused, setComposerFocused] = useState(false);
  /** Anexo da prévia que está sendo recortado; o resultado troca o anexo. */
  const [cropping, setCropping] = useState<DraftAttachment | null>(null);
  const promptHistory = useMemo(() => promptHistoryOf(chat.items), [chat.items]);
  /** Parte de baixo (indicador, anexos, comandos, setas, composer): o aviso de atualização flutua acima dela. */
  const bottomRef = useRef<HTMLDivElement>(null);
  useCssHeight(bottomRef, '--chat-bottom-h');

  // Unsent text or attachment drafts hold the app's reload (see updates/reloadGuard.ts).
  useReloadGuard(draft.trim() !== '' || attachments.drafts.length > 0);

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

  // Background work: the view the cards read their state from, the header chip count, and the nested tree of the
  // loaded window (children under their parent card; the node cache keeps unchanged rows memoized).
  const backgroundView = useMemo<BackgroundView>(
    () => ({ active: isActiveStatus(chat.status), turnEnds: chat.turnEnds }),
    [chat.status, chat.turnEnds],
  );
  const backgroundList = useMemo(() => backgroundEntries(chat.items, backgroundView), [chat.items, backgroundView]);
  const chipCount = backgroundChipCount(backgroundList, chat.turnEnds);
  const nodeCache = useRef<ReadonlyMap<string, ChatNode>>(new Map());
  const topNodes = useMemo(() => {
    const nested = nestItems(chat.items.slice(start), nodeCache.current);
    nodeCache.current = nested.nodes;
    return nested.roots;
  }, [chat.items, start]);

  // The first render that has the history fixes what counts as history; everything appended later is live.
  useEffect(() => {
    if (controller.loaded && history === null) setHistory(historyOf(chat.items));
  }, [controller.loaded, history, chat.items]);

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

  /** Chip or drawer row: widens the window when the item is older than it, then asks the effect to scroll to it. */
  function revealBackground(id: string) {
    const index = chat.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    if (index < start) setFloor(index);
    setRevealRequest({ id });
  }

  // After a reveal: opens the collapsed cards around the item, centres it in the timeline and flashes it briefly.
  useEffect(() => {
    if (revealRequest === null) return;
    const timeline = timelineRef.current;
    if (timeline === null) return;
    const element = timeline.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(revealRequest.id)}"]`);
    if (element === null) return;
    for (let ancestor = element.parentElement; ancestor !== null && ancestor !== timeline; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    const box = timeline.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    const offset = target.top - box.top - (box.height - target.height) / 2;
    timeline.scrollTo({ top: timeline.scrollTop + offset, behavior: reduceMotion ? 'auto' : 'smooth' });
    seenTop.current = timeline.scrollTop;
    stick.current = false;
    element.dataset.highlighted = 'true';
    window.setTimeout(() => {
      delete element.dataset.highlighted;
    }, 1600);
  }, [revealRequest]);

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

  /** The "Ir para o fim" button: a smooth scroll the user asked for. Streaming follow (below) stays instant. */
  function jumpToEnd() {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    stick.current = true;
    setAtBottom(true);
    // Only a real move produces the scroll events that clear the guard; with nothing to scroll it would stay armed.
    jumping.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 0;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
    seenTop.current = timeline.scrollTop;
  }

  /** A touch or a wheel turn is the user taking over: a jump in progress stops protecting the position. */
  function endJump() {
    jumping.current = false;
  }

  function onTimelineScroll() {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    seenTop.current = timeline.scrollTop;
    const near = isNearBottom(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight);
    // The positions a smooth jump passes through are not "away from the end": keep following until it arrives.
    if (jumping.current) {
      if (!near) return;
      jumping.current = false;
    }
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
    if (!acceptsPrompt(chat.status) || sending) return;

    const text = draft;
    // `/loop` belongs to Loop mode, not to the agent: with no arguments it opens the sheet; with arguments it creates the loop.
    const loopDecision = loopCommandFor(text, attachments.drafts.length > 0);
    if (loopDecision.kind === 'sheet') {
      clearDraft();
      openLoop();
      return;
    }
    if (loopDecision.kind === 'invalid') {
      setLoopNotice(loopDecision.message);
      return;
    }
    if (loopDecision.kind === 'start') {
      await startLoopFromComposer(loopDecision.request);
      return;
    }

    // `/model` sent with no arguments opens its picker; with arguments, attachments, or on a stopped session
    // (the picker's set_config needs a live agent) it is sent as text.
    const bare = attachments.drafts.length === 0 ? bareCommandName(text) : undefined;
    const picker =
      bare === undefined || chat.status !== 'idle' ? undefined : nativePickerFor(bare, controller.configOptions);
    if (bare !== undefined && picker !== undefined) {
      clearDraft();
      openCommandSheet({ kind: 'config', name: bare, option: picker });
      return;
    }

    if (attachments.drafts.length === 0) {
      if (controller.sendPrompt(text)) {
        clearDraft();
        setSends((count) => count + 1);
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
        clearDraft();
        setSends((count) => count + 1);
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

  // Campo cresce com o texto (até max-h-40, pelo CSS). Vazio volta à altura do CSS (uma linha).
  useLayoutEffect(() => {
    const field = textarea.current;
    if (field === null) return;
    field.style.height = draft === '' ? '' : 'auto';
    if (draft !== '') field.style.height = `${field.scrollHeight}px`;
  }, [draft]);

  // Depois de inserir um comando: o campo já tem o texto novo, então o cursor vai para o fim do comando.
  useLayoutEffect(() => {
    const target = pendingCaret.current;
    if (target === null || textarea.current === null) return;
    pendingCaret.current = null;
    textarea.current.setSelectionRange(target, target);
  }, [draft]);

  /** Opens the Loop mode sheet. The composer loses focus so the iOS keyboard does not stay over the sheet. */
  function openLoop() {
    setCommandsOpen(false);
    setCommandQuery('');
    textarea.current?.blur();
    setLoopOpen(true);
  }

  /** A typed `/loop <args>`: creates the loop directly. Success clears the composer; an error keeps the text to fix. */
  async function startLoopFromComposer(request: LoopRequest) {
    try {
      await controller.saveLoop(request);
      clearDraft();
      setLoopNotice(t('loop.started'));
      stick.current = true;
    } catch (caught) {
      setLoopNotice(describeLoopError(caught));
    }
  }

  /** Opens the sheet of a command and closes the menu. The composer is blurred so the iOS keyboard does not stay over it. */
  function openCommandSheet(sheet: CommandSheet) {
    setCommandsOpen(false);
    setCommandQuery('');
    setCommandSheet(sheet);
    textarea.current?.blur();
  }

  /** Empties the composer after a send and leaves the history navigation (the next Up starts from the newest again). */
  function clearDraft() {
    setDraft('');
    setCaret(0);
    setHistoryCursor(IDLE_PROMPT_CURSOR);
  }

  /** Shows a recalled prompt (or the draft back) with the caret at its end. Recalled text only fills the composer. */
  function applyRecall(step: PromptStep) {
    setHistoryCursor(step.cursor);
    if (step.text !== draft) {
      setDraft(step.text);
      setCaret(step.text.length);
      pendingCaret.current = step.text.length;
    }
  }

  /** Sends a command as text and keeps the chat at the end, like a submit. */
  function sendCommandText(text: string) {
    if (controller.sendPrompt(text)) stick.current = true;
  }

  /** Puts `/<text> ` before the composer text and focuses it. The tap is a user gesture, so the keyboard opens. */
  function insertCommandText(text: string) {
    const next = insertCommand(draft, 0, text, 'prefix');
    setDraft(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    textarea.current?.focus();
  }

  /** Items of the command sheet: the config options (current one checked), or the subcommands of the hint. */
  function commandSheetItems(sheet: CommandSheet): ActionSheetItem[] {
    if (sheet.kind === 'config') {
      const { name, option } = sheet;
      // A model picker that spans providers gets one section per provider; other lists stay flat.
      const choices = configSheetChoices(option).map(
        (choice): ActionSheetItem => ({
          label: choice.label,
          detail: choice.detail,
          checked: choice.checked,
          section: choice.section,
          onSelect: () => {
            controller.setConfig(option.id, choice.value);
          },
        }),
      );
      return [
        ...choices,
        { label: t('commandSheet.sendToAgent', { name }), tone: 'muted', onSelect: () => sendCommandText(`/${name}`) },
      ];
    }
    const { name, hint } = sheet;
    const items: ActionSheetItem[] = [];
    if (hint.optional) items.push({ label: t('commandSheet.noArgument'), onSelect: () => sendCommandText(`/${name}`) });
    for (const choice of hint.choices) {
      items.push({
        label: choice.value,
        mono: true,
        onSelect: () => {
          if (choice.takesArgument) insertCommandText(`${name} ${choice.value}`);
          else sendCommandText(`/${name} ${choice.value}`);
        },
      });
    }
    items.push({ label: t('commandSheet.typeArguments'), tone: 'muted', onSelect: () => insertCommandText(name) });
    return items;
  }

  /** Insere o comando e devolve o foco ao campo (o clique é gesto do usuário, então o teclado continua aberto). */
  function pickCommand(command: AvailableCommand) {
    // A `/loop` picked from the menu opens the Loop mode sheet. Typed text is handled the same way as for other commands.
    if (command.name === 'loop') {
      if (!commandsOpen) {
        setDraft(draft.slice(caret).replace(/^ /, ''));
        setCaret(0);
      }
      openLoop();
      return;
    }
    const sheet = commandSheetFor(command, controller.configOptions);
    if (sheet !== undefined) {
      // Opened by typing `/busca`: that trigger leaves the composer. Opened by the `/` button: the typed text stays.
      if (!commandsOpen) {
        setDraft(draft.slice(caret).replace(/^ /, ''));
        setCaret(0);
      }
      openCommandSheet(sheet);
      return;
    }
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
    setAttachNotice(rejected > 0 ? t('composer.attachmentLimit', { limit: ATTACHMENT_LIMIT }) : null);
  }

  /** Recorte aberto no visualizador de imagens: entra como anexo da prévia, igual a um arquivo escolhido. */
  function attachFromViewer(file: File) {
    const rejected = attachments.add([file]);
    setAttachNotice(rejected > 0 ? t('composer.attachmentLimit', { limit: ATTACHMENT_LIMIT }) : null);
  }

  /** Abre o recorte de uma imagem da prévia. Só imagens (com prévia) podem ser recortadas. */
  function openCrop(id: string) {
    const target = attachments.drafts.find((draft) => draft.id === id);
    if (target !== undefined && target.previewUrl !== null) setCropping(target);
  }

  const resumable = isResumable(chat.status);
  // The line above the composer. `idle` has none.
  const working = controller.resuming
    ? t('working.resuming')
    : chat.status === 'idle'
      ? undefined
      : t(`working.${chat.status}`);
  // Stopped and error sessions take a message: sending it resumes the session.
  const placeholder = controller.resuming ? t('placeholder.resuming') : t(`placeholder.${chat.status}`);
  const inputEnabled = isInputEnabled(chat.status);
  // Stopped and error sessions keep the composer open: a message resumes the session (see acceptsPrompt).
  const composerOpen = inputEnabled || resumable;
  const notResumable =
    controller.resumeError instanceof ApiError && controller.resumeError.kind === 'not_resumable';
  const unseen = unseenSince(baseline.current, chat.items.length);
  const hasContent = draft.trim() !== '' || attachments.drafts.length > 0;
  const canSend = acceptsPrompt(chat.status) && hasContent && !sending;
  // Menu: aberto pelo botão, ou pelo texto `/busca` no começo do composer. Só com o campo habilitado.
  const typedQuery = inputEnabled ? slashQuery(draft, caret) : undefined;
  const menuQuery = !inputEnabled ? undefined : commandsOpen ? commandQuery : typedQuery;
  const boxStyle = viewport === null ? undefined : { top: viewport.top, height: viewport.height };

  /**
   * Setas do teclado físico: ↑ com o cursor no início recupera a mensagem anterior, ↓ com o cursor no fim vai para a
   * seguinte. Com o menu de comandos aberto as setas são dele, então aqui não fazem nada.
   */
  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      enterSends(
        { key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, isComposing: event.nativeEvent.isComposing },
        enterToSend,
      )
    ) {
      event.preventDefault();
      // With the menu of a typed `/rev` open, Enter completes the command (the row on top) instead of sending half of it.
      const completing = !commandsOpen && typedQuery !== undefined ? commandForEnter(controller.commands, typedQuery) : undefined;
      if (completing !== undefined) {
        pickCommand(completing);
        return;
      }
      if (canSend) event.currentTarget.form?.requestSubmit();
      return;
    }
    if (menuQuery !== undefined || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const field = event.currentTarget;
    if (field.selectionStart !== field.selectionEnd) return;
    if (event.key === 'ArrowUp' && field.selectionStart === 0) {
      const step = recallOlder(promptHistory, historyCursor, draft);
      if (step === null) return;
      event.preventDefault();
      applyRecall(step);
    } else if (event.key === 'ArrowDown' && field.selectionStart === draft.length) {
      const step = recallNewer(promptHistory, historyCursor);
      if (step === null) return;
      event.preventDefault();
      applyRecall(step);
    }
  }

  /** Botões ↑ e ↓ ao lado do composer. O toque não tira o foco do campo, então o teclado do iOS continua aberto. */
  function recallOlderPrompt() {
    const step = recallOlder(promptHistory, historyCursor, draft);
    if (step !== null) applyRecall(step);
    textarea.current?.focus();
  }

  function recallNewerPrompt() {
    const step = recallNewer(promptHistory, historyCursor);
    if (step !== null) applyRecall(step);
    textarea.current?.focus();
  }

  // The history row shows while the composer has focus, or while a recalled prompt is on screen (so the way back stays).
  const historyRowVisible = promptHistory.length > 0 && composerOpen && (composerFocused || historyCursor.index !== null);
  const place =
    current.worktree === null
      ? `${workspace.name} · ${machineName}`
      : `${workspace.name} · ${current.worktree.branch} · ${machineName}`;

  return (
    <ChatAttachContext.Provider value={composerOpen ? attachFromViewer : null}>
      <div
        className="fixed inset-x-0 top-0 bottom-0 z-[5] flex justify-center bg-background text-foreground wide:absolute wide:inset-0 wide:z-0"
        style={embedded ? undefined : boxStyle}
      >
        <div className="flex h-full min-h-0 w-full max-w-[560px] flex-col gap-2 pt-[calc(env(safe-area-inset-top,0px)+8px)] pr-[calc(env(safe-area-inset-right,0px)+12px)] pl-[calc(env(safe-area-inset-left,0px)+12px)] wide:max-w-none wide:pt-3 wide:pr-6 wide:pl-6">
          <div className="flex shrink-0 flex-col">
          <header className="flex min-h-11 items-center gap-1">
            {backAffordance === 'back' && (
              <Button variant="ghost" size="icon" className="-ml-2" aria-label={t('actions.back', { ns: 'common' })} onClick={() => nav.back()}>
                <ChevronLeft className="size-6" aria-hidden="true" />
              </Button>
            )}
            <div className="flex min-w-0 flex-1 flex-col px-1">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  role="img"
                  aria-label={sessionStatusText(chat.status, 'acp')}
                  data-status={chat.status}
                  className="flex shrink-0"
                >
                  <StatusDot tone={STATUS_TONE[chat.status]} pulse={chat.status === 'starting'} />
                </span>
                <h1 className="min-w-0 truncate text-base leading-6 font-semibold tracking-tight">{displaySessionTitle(current.title)}</h1>
              </div>
            </div>
            {current.kind === 'acp' && !compactHeader && (
              <Button variant="ghost" size="icon" aria-label={t('header.usage')} title={tip(t('header.usage'))} onClick={() => setUsageOpen(true)}>
                <Gauge aria-hidden="true" />
              </Button>
            )}
            {current.kind === 'acp' && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('header.loop')}
                title={tip(t('header.loop'))}
                aria-haspopup="dialog"
                aria-expanded={loopOpen}
                onClick={openLoop}
              >
                {loopActive ? <Repeat1 aria-hidden="true" /> : <Repeat aria-hidden="true" />}
              </Button>
            )}
            {sidePane && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sessions.files', { ns: 'workspace' })}
                  title={t('sessions.files', { ns: 'workspace' })}
                  onClick={() => nav.push({ kind: 'files', workspace, path: '' })}
                >
                  <FolderTree aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('sessions.terminal', { ns: 'workspace' })}
                  title={t('sessions.terminal', { ns: 'workspace' })}
                  onClick={() => setShellOpen(true)}
                >
                  <SquareTerminal aria-hidden="true" />
                </Button>
              </>
            )}
            {!compactHeader && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('header.changes')}
                title={tip(t('header.changes'))}
                onClick={() => nav.push({ kind: 'changes', workspace, session: current })}
              >
                <GitCompare aria-hidden="true" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('header.configure')}
              title={tip(t('header.configure'))}
              aria-haspopup="dialog"
              aria-expanded={configOpen}
              onClick={() => setConfigOpen(true)}
            >
              <SlidersHorizontal aria-hidden="true" />
            </Button>
            <ActionSheetButton
              label={t('header.moreActions')}
              title={sessionTitle(current, agentLabel)}
              items={[
                ...(compactHeader && current.kind === 'acp'
                  ? [{ label: t('header.usage'), onSelect: () => setUsageOpen(true) }]
                  : []),
                ...(compactHeader
                  ? [{ label: t('header.changes'), onSelect: () => nav.push({ kind: 'changes', workspace, session: current }) }]
                  : []),
                { label: t('header.removeFromApp'), tone: 'danger', onSelect: () => setRemoving(true) },
              ]}
            />
          </header>
            {/* Place line and chips span the whole header, so they keep room beside the buttons. Indented to the title. */}
            <div className={cn('-mt-1 flex min-w-0 items-center gap-2 pr-1', backAffordance === 'back' ? 'pl-[62px]' : 'pl-[22px]')}>
              <p data-slot="session-place" className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground">{place}</p>
              {current.kind === 'acp' && <LoopChip loop={controller.loop} onOpen={openLoop} />}
              {/* 44px tap area around a 24px pill; the negative margins keep the header's height unchanged. */}
              {chipCount > 0 && (
                <button
                  type="button"
                  data-slot="background-chip"
                  aria-label={t('header.backgroundWork', { count: chipCount })}
                  aria-haspopup="dialog"
                  aria-expanded={backgroundOpen}
                  onClick={() => setBackgroundOpen(true)}
                  className="-my-2.5 flex shrink-0 animate-enter items-center py-2.5 motion-reduce:animate-none"
                >
                  <span className="flex h-6 items-center gap-1 rounded-full bg-secondary px-2 text-xs font-medium tabular-nums text-foreground">
                    <Layers className="size-3.5" aria-hidden="true" />
                    {chipCount}
                  </span>
                </button>
              )}
            </div>
          </div>

          <UsageDrawer
            open={usageOpen}
            onOpenChange={setUsageOpen}
            client={api}
            sessionId={current.id}
            agentId={current.agent}
            agentName={agentLabel}
            account={sessionAccountInfo(accounts.data, current.agent, current.accountId)}
            onResume={() => void controller.resume()}
          />

          <BackgroundDrawer
            open={backgroundOpen}
            onOpenChange={setBackgroundOpen}
            entries={backgroundList}
            onPick={(id) => {
              setBackgroundOpen(false);
              revealBackground(id);
            }}
          />

          {current.kind === 'acp' && (
            <LoopSheet
              open={loopOpen}
              onOpenChange={setLoopOpen}
              loop={controller.loop}
              loaded={controller.loopLoaded}
              busy={controller.loopBusy}
              canSend={acceptsPrompt(chat.status)}
              nativeClaude={current.agent === 'claude'}
              actions={controller}
              onNotice={setLoopNotice}
              onNativeSend={(text) => {
                if (!controller.sendPrompt(text)) return false;
                stick.current = true;
                return true;
              }}
            />
          )}

          <Drawer open={configOpen} onOpenChange={setConfigOpen}>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>{t('configSheet.title')}</DrawerTitle>
              </DrawerHeader>
              <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-4 pt-3 pb-[max(env(safe-area-inset-bottom,0px),16px)] wide:gap-5">
                {accountSelector !== null && (
                  <section className="flex flex-col gap-2">
                    <ListGroup label={t('configSheet.account')}>
                      <AccountSelect
                        profiles={accountSelector.profiles}
                        value={sessionAccount(accountSelector, current.accountId)}
                        disabled={accountBusy || accountChangeLocked(chat.status)}
                        busy={accountBusy}
                        showHint={accountChangeLocked(chat.status) && !accountBusy}
                        onChange={(accountId) => {
                          setAccountBusy(true);
                          setAccountError(null);
                          controller
                            .setAccount(accountId)
                            .catch((caught: unknown) => setAccountError(caught))
                            .finally(() => setAccountBusy(false));
                        }}
                      />
                    </ListGroup>
                    {accountError !== null && <ErrorNotice message={describeSessionAccountError(accountError)} />}
                  </section>
                )}
                {primary.length > 0 && (
                  <ListGroup label={t('configSheet.options')}>
                    {primary.map((control) => (
                      <li key={control.option.id}>
                        <ConfigSelect
                          label={control.label}
                          option={control.option}
                          onChange={(value) => controller.setConfig(control.option.id, value)}
                        />
                      </li>
                    ))}
                  </ListGroup>
                )}
                {extra.length > 0 && (
                  <section aria-labelledby="config-extra-title" className="flex flex-col gap-2">
                    <SectionHeading icon={Settings2} id="config-extra-title">
                      {t('configSheet.more')}
                    </SectionHeading>
                    <ConfigControls options={extra} onChange={(id, value) => controller.setConfig(id, value)} />
                  </section>
                )}
              </div>
            </DrawerContent>
          </Drawer>

          {/* `contents` on the phone (the notices stay flex items of the column); on wide screens the transcript's reading column. */}
          <div className="contents wide:mx-auto wide:flex wide:w-full wide:max-w-[1040px] wide:flex-col wide:gap-2 wide:empty:hidden">
            <ErrorNotice error={controller.loadError} onRepair={onRepair} />
            <ErrorNotice
              error={controller.resumeError}
              action={notResumable ? { label: t('composer.newSession'), onClick: () => setSheetOpen(true) } : undefined}
            />
            <ErrorNotice error={sendError} onRepair={onRepair} />

            {controller.notice !== null && (
              <div
                data-slot="notice"
                role="status"
                className="flex shrink-0 animate-enter items-center justify-between gap-2 rounded-xl bg-muted py-1.5 pr-1.5 pl-3.5 motion-reduce:animate-none"
              >
                <p className="text-[15px] leading-snug">{controller.notice}</p>
                <Button variant="ghost" onClick={controller.dismissNotice}>
                  OK
                </Button>
              </div>
            )}

            {loopNotice !== null && (
              <div
                data-slot="loop-notice"
                role="status"
                className="flex shrink-0 animate-enter items-center justify-between gap-2 rounded-xl bg-muted py-1.5 pr-1.5 pl-3.5 motion-reduce:animate-none"
              >
                <p className="text-[15px] leading-snug">{loopNotice}</p>
                <Button variant="ghost" onClick={() => setLoopNotice(null)}>
                  OK
                </Button>
              </div>
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              data-slot="chat-timeline"
              ref={timelineRef}
              onScroll={onTimelineScroll}
              onTouchStart={endJump}
              onWheel={endJump}
              className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain [overflow-anchor:none] px-0.5 py-2 *:shrink-0 wide:items-center wide:px-2"
            >
              {!controller.loaded && controller.loadError === null && (
                <p className="text-sm text-muted-foreground wide:w-full wide:max-w-[1040px]">{t('timeline.loading')}</p>
              )}
              {start > 0 && (
                <Button variant="secondary" className="self-center" onClick={loadEarlier}>
                  {t('timeline.loadEarlier')}
                </Button>
              )}
              <div ref={feedRef} data-slot="chat-feed" className="flex min-w-0 flex-col gap-3 wide:w-full wide:max-w-[1040px]">
                {topNodes.map((node) => (
                  <div
                    key={node.item.id}
                    data-item-id={node.item.id}
                    className={cn(ITEM_FRAME_CLASS, arrivedLive(history, node.item.id) && 'animate-enter motion-reduce:animate-none')}
                  >
                    <ChatItemView node={node} api={api} view={backgroundView} history={history} />
                  </div>
                ))}
              </div>
              {chat.permissions.map((request) => (
                <div key={request.requestId} className="wide:w-full wide:max-w-[1040px]">
                  <PermissionCard
                    api={api}
                    request={request}
                    onRespond={(optionId) => controller.respond(request.requestId, optionId)}
                  />
                </div>
              ))}
            </div>
            {!atBottom && (
              <Button
                variant="outline"
                data-slot="jump-bottom"
                className="absolute inset-x-0 bottom-3 z-10 mx-auto w-max animate-enter rounded-full bg-card shadow-lg motion-reduce:animate-none"
                onClick={jumpToEnd}
              >
                <ArrowDown aria-hidden="true" />
                {t('timeline.jumpToEnd')}
                {unseen > 0 && (
                  // Keyed by the count: each new item pops the badge once.
                  <span
                    key={unseen}
                    className="flex h-5 min-w-5 animate-pop items-center justify-center rounded-full bg-primary px-1.5 text-xs tabular-nums text-primary-foreground motion-reduce:animate-none"
                  >
                    {unseen}
                  </span>
                )}
              </Button>
            )}
          </div>

          <div ref={bottomRef} className="flex shrink-0 flex-col gap-2 wide:w-full">
            {working !== undefined && (
              <div
                role="status"
                className="flex min-h-11 shrink-0 animate-enter items-center gap-2.5 pl-1 text-sm text-muted-foreground motion-reduce:animate-none"
              >
                {controller.resuming ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none" aria-hidden="true" />
                ) : chat.status === 'running' ? (
                  <RunningDots />
                ) : (
                  <StatusDot tone={STATUS_TONE[chat.status]} pulse={chat.status === 'starting'} />
                )}
                <span className="min-w-0 flex-1 truncate">{working}</span>
                {chat.status === 'running' && (
                  <Button variant="destructive-ghost" onClick={() => controller.cancel()}>
                    {t('composer.stop')}
                  </Button>
                )}
                {resumable && !controller.resuming && (
                  <Button onClick={() => void controller.resume()}>{t('composer.resume')}</Button>
                )}
              </div>
            )}

            {(attachments.drafts.length > 0 || attachNotice !== null) && (
              <div className="flex shrink-0 flex-col gap-1.5">
                <AttachmentDrafts drafts={attachments.drafts} onRemove={attachments.remove} onCrop={openCrop} />
                {attachNotice !== null && (
                  <p className="text-sm text-muted-foreground" role="status">
                    {attachNotice}
                  </p>
                )}
              </div>
            )}

            {progress !== null && (
              <div role="status" className="flex shrink-0 items-center gap-2.5">
                <div
                  role="progressbar"
                  aria-label={t('composer.uploadProgress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                  className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full bg-primary transition-[width] duration-200 ease-(--ease-out-premium) motion-reduce:transition-none"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">{t('composer.uploading', { percent: Math.round(progress * 100) })}</span>
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

            {historyRowVisible && (
              <div data-slot="prompt-history" className="flex justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('composer.previous')}
                  className="text-muted-foreground"
                  disabled={historyCursor.index === 0}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={recallOlderPrompt}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('composer.next')}
                  className="text-muted-foreground"
                  disabled={historyCursor.index === null}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={recallNewerPrompt}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </div>
            )}

            <form
              data-slot="chat-input"
              className="flex shrink-0 items-end gap-1.5 border-t border-border pt-2 pb-[max(8px,env(safe-area-inset-bottom,0px))]"
              onSubmit={(event) => void submit(event)}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                onChange={onFilesPicked}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-slot="attach-button"
                aria-label={t('composer.attach')}
                className="text-muted-foreground"
                disabled={!composerOpen || sending}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-slot="command-button"
                aria-label={t('composer.commands')}
                aria-expanded={commandsOpen}
                className={cn('text-muted-foreground', commandsOpen && 'bg-accent text-foreground')}
                disabled={!inputEnabled || sending}
                onClick={() => {
                  setCommandQuery('');
                  setCommandsOpen((open) => !open);
                }}
              >
                <SquareSlash aria-hidden="true" />
              </Button>
              <textarea
                ref={textarea}
                data-slot="chat-textarea"
                rows={1}
                value={draft}
                placeholder={placeholder}
                disabled={!composerOpen}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setCaret(event.target.selectionStart);
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={onComposerKeyDown}
                onFocus={() => setComposerFocused(true)}
                onBlur={() => setComposerFocused(false)}
                className={cn(
                  'max-h-40 min-w-0 flex-1 resize-none rounded-md border border-input bg-card px-3 py-2.5 text-base leading-snug text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 motion-reduce:transition-none',
                  // Stopped and error sessions show a longer placeholder ("Retomar e enviar"), which needs two lines at 320 px.
                  resumable ? 'min-h-[4.25rem]' : 'min-h-11',
                )}
              />
              {/* Below 360px the text would take the room the field needs: an icon, with the text kept for screen readers. */}
              {/* Keyed by the send count: each send remounts the button, so it pops once. Enabled and disabled fade in the base button. */}
              <Button
                key={sends}
                type="submit"
                className={cn('px-3.5 max-[359px]:size-11 max-[359px]:px-0', sends > 0 && 'animate-pop motion-reduce:animate-none')}
                disabled={!canSend}
              >
                <SendHorizontal className="hidden max-[359px]:block" aria-hidden="true" />
                <span className="max-[359px]:sr-only">{sending ? t('composer.sending') : t('composer.send')}</span>
              </Button>
            </form>
            {composerOpen && (
              <p data-slot="composer-hint" className="-mt-1 hidden pb-2 text-right text-xs text-muted-foreground wide:pointer-fine:block">
                {tw('composerHint')}
              </p>
            )}
          </div>

          {removing && (
            <RemoveSessionSheet
              agentLabel={agentLabel}
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

          {commandSheet !== null && (
            <ActionSheet
              label={
                commandSheet.kind === 'config'
                  ? t('commandSheet.configLabel', { name: commandSheet.name })
                  : t('commandSheet.choicesLabel', { name: commandSheet.name })
              }
              title={`/${commandSheet.name}`}
              items={commandSheetItems(commandSheet)}
              onClose={() => setCommandSheet(null)}
            />
          )}

          {cropping !== null && cropping.previewUrl !== null && (
            <ImageCropDialog
              src={cropping.previewUrl}
              name={cropping.file.name}
              mime={cropping.file.type}
              confirmLabel={t('composer.useCrop')}
              onCancel={() => setCropping(null)}
              onConfirm={(file) => {
                attachments.replace(cropping.id, file);
                setCropping(null);
              }}
            />
          )}

          {shellOpen && (
            <ShellSheet
              api={api}
              workspace={workspace}
              onClose={() => setShellOpen(false)}
              onCreated={(created) => {
                setShellOpen(false);
                nav.push({ kind: 'chat', workspace, session: created });
              }}
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
    </ChatAttachContext.Provider>
  );
}
