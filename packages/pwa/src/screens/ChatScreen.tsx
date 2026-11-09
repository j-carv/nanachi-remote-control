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
  Copy,
  FolderTree,
  Layers,
  LoaderCircle,
  MessageCircleQuestion,
  Mic,
  Paperclip,
  Pencil,
  Quote,
  Send,
  Settings2,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import type {
  AvailableCommand,
  ConfigValue,
  LoopRequest,
  Session,
  SessionConfigOption,
  SessionStatus,
  Workspace,
} from '@nanachi/shared';
import { isDangerousSwitch, modeOptionOf, splitOptions } from '../agentConfig.js';
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
import { copyText } from '../components/CopyButton.js';
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
import { ToolActivity } from '../chat/ToolActivity.js';
import { groupToolRuns } from '../chat/activityGrouping.js';
import { BackgroundDrawer } from '../chat/BackgroundDrawer.js';
import { PlanDock } from '../chat/PlanDock.js';
import { RunningDots } from '../chat/RunningIndicator.js';
import { arrivedLive, historyOf, type HistoryIds } from '../chat/liveItems.js';
import { LoopChip } from '../chat/LoopChip.js';
import { WorkModeChip, WorkModeConfirmSheet } from '../chat/WorkModeChip.js';
import { LoopSheet } from '../chat/LoopSheet.js';
import { loopCommandFor } from '../chat/loopCommand.js';
import { planHeaderActions } from '../chat/headerActions.js';
import { headerMenuRows } from '../chat/headerMenuRows.js';
import { PlaceLine } from '../chat/PlaceLine.js';
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
import { acceptsConfigChange, acceptsPrompt, isInputEnabled, isResumable, queuesPrompt } from '../chat/controls.js';
import { useAttachmentDrafts, type DraftAttachment } from '../chat/useAttachmentDrafts.js';
import { useChat } from '../chat/useChat.js';
import { ENTER_SENDS_QUERY, enterSends } from '../wide/layout.js';
import { useBackAffordance, useLayout } from '../wide/layoutContext.js';
import { displaySessionTitle, sessionStatusText, sessionTitle } from '../sessionText.js';
import { useAsync } from '../useAsync.js';
import { PermissionCard } from '../chat/PermissionCard.js';
import { UserQuestionCard } from '../chat/UserQuestionCard.js';
import { FileRequestCard } from '../chat/FileRequestCard.js';
import type { FileRequestItem, UserQuestionItem } from '../chat/reducer.js';
import {
  WINDOW_INITIAL,
  WINDOW_STEP,
  earlierFloor,
  initialFloor,
  isNearBottom,
  unseenSince,
} from '../chat/scrollFollow.js';
import { conversationItemCount, isLearningOnlyChange } from '../chat/learning.js';
import type { StorageLike } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { useReloadGuard } from '@/updates/reloadGuard';
import { currentLanguage } from '../i18n/index.js';
import { supportsWhisperRecording } from '../whisper/recording.js';
import { appendWhisperTranscript, useWhisperDictation } from '../whisper/useWhisperDictation.js';
import { useTranscriptionStatus } from '../whisper/useTranscriptionStatus.js';
import {
  chatVisitKey, firstUnreadIndex, forgetChatVisit, insertMessageInDraft, readableSequence, readChatDraft, readChatPosition,
  visibleReadSequence, writeChatDraft, writeChatPosition,
} from '../chat/chatVisit.js';
import type { ActionMessage } from '../chat/MessageActionsTrigger.js';
import { stripPromptNotes } from '../chat/promptNotes.js';
import { splitLoopMarkers } from '../chat/loopMarkers.js';
import { stripAnsi } from '../chat/ansi.js';

interface ChatScreenProps {
  machineId: string;
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
  machineId,
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
  const conversationCount = conversationItemCount(chat.items);
  const current = controller.session;
  const viewport = useVisualViewport();
  const { primary, extra } = splitOptions(controller.configOptions, current.agent);
  /** The work mode chip's option: an ACP session whose agent announces a mode select. */
  const modeOption = current.kind === 'acp' ? modeOptionOf(controller.configOptions) : undefined;
  /** A change waiting for the user's OK: a switch into a dangerous work mode (see `changeConfig`). */
  const [pendingDanger, setPendingDanger] = useState<{ configId: string; value: string } | null>(null);
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
  // Wide screens: the chat sits in the right pane (not over the whole window); from 1280 px it can open files and a
  // terminal in a third pane. Enter sends only for a mouse and keyboard (a touch screen keeps Enter as a new line).
  const layout = useLayout();
  const embedded = layout !== 'phone';
  const backAffordance = useBackAffordance();
  const enterToSend = useMediaQuery(ENTER_SENDS_QUERY);
  const [shellOpen, setShellOpen] = useState(false);
  /** A tooltip for the icon buttons of the header: a pointer has no other way to read them. */
  const tip = (label: string): string | undefined => (embedded ? label : undefined);
  /** Item the header chip asked to show. The effect below scrolls to it once it is rendered. */
  const [revealRequest, setRevealRequest] = useState<{ id: string } | null>(null);
  const visitKey = chatVisitKey(machineId, session.id);
  const [draft, setDraft] = useState(() => readChatDraft(storage, visitKey));
  /** The history cursor keeps the original draft while an earlier prompt is on screen. */
  const [historyCursor, setHistoryCursor] = useState<PromptCursor>(IDLE_PROMPT_CURSOR);
  const [actionsMessage, setActionsMessage] = useState<ActionMessage | null>(null);
  const [messageNotice, setMessageNotice] = useState<string | null>(null);
  /** Posição do cursor no composer: o menu de comandos abre quando o texto até aqui é `/busca`. */
  const [caret, setCaret] = useState(0);
  /** Folha aberta por um comando: seletor nativo (opção da sessão) ou subcomandos do hint. */
  const [commandSheet, setCommandSheet] = useState<CommandSheet | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  /** Cursor a aplicar depois que o comando entrou no texto (o React ainda não atualizou o campo). */
  const pendingCaret = useRef<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const attachments = useAttachmentDrafts();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const canRecord = current.kind === 'acp' && supportsWhisperRecording();
  const { status: transcriptionStatus } = useTranscriptionStatus(api, canRecord);
  const dictation = useWhisperDictation(api, current.id, currentLanguage(), (text) => {
    setHistoryCursor(IDLE_PROMPT_CURSOR);
    setDraft((previous) => appendWhisperTranscript(previous, text));
  });
  const dictating = dictation.stage !== 'idle';
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
  const quietLearningResize = useRef(false);
  const scrollSnapshot = useRef<{ items: typeof chat.items; floor: number | null; start: number; pending: number; loaded: boolean } | null>(null);
  const learningAnchor = useRef<{ element: Element; top: number } | null>(null);
  /** User-requested scrolls are smooth; with the system's reduced motion setting they are instant. */
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  /** Number of sends. The send button is keyed by it, so each send pops the button once. */
  const [sends, setSends] = useState(0);
  /** Item visível antes de carregar anteriores: depois da mudança a tela volta a mostrar o mesmo ponto. */
  const anchor = useRef<{ element: Element; id: string | null; top: number } | null>(null);
  const pendingRestore = useRef<SavedPosition | undefined>(savedPositions.get(visitKey));
  const [visitAfter, setVisitAfter] = useState<number | null | undefined>(() => readChatPosition(storage, visitKey));
  const [unreadId, setUnreadId] = useState<string | null>(null);
  const unreadMarker = useRef<HTMLDivElement>(null);
  const readThrough = useRef(visitAfter ?? 0);
  const readTimer = useRef<number | null>(null);
  const pendingCardCount = useRef(0);
  /** Posição vista pelo último evento de rolagem (ver settleUserScroll). */
  const seenTop = useRef(0);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);
  /** Sair da sessão uma vez só: remover pelo app e o broadcast session_removed chegam juntos. */
  const leaving = useRef(false);
  const [composerFocused, setComposerFocused] = useState(false);
  /** Anexo da prévia que está sendo recortado; o resultado troca o anexo. */
  const [cropping, setCropping] = useState<DraftAttachment | null>(null);
  const promptHistory = useMemo(() => promptHistoryOf(chat.items), [chat.items]);
  const plan = useMemo(() => chat.items.find((item) => item.kind === 'plan'), [chat.items]);
  /** Parte de baixo (indicador, anexos, comandos, setas, composer): o aviso de atualização flutua acima dela. */
  const bottomRef = useRef<HTMLDivElement>(null);
  useCssHeight(bottomRef, '--chat-bottom-h');

  // Unsent text or attachment drafts hold the app's reload (see updates/reloadGuard.ts).
  useReloadGuard(draft.trim() !== '' || attachments.drafts.length > 0 || dictating);

  const savedDraft = historyCursor.index === null ? draft : historyCursor.draft;
  useLayoutEffect(() => writeChatDraft(storage, visitKey, savedDraft), [storage, visitKey, savedDraft]);

  useEffect(() => {
    if (messageNotice === null) return;
    const timer = window.setTimeout(() => setMessageNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [messageNotice]);

  function flushReadPosition() {
    if (readTimer.current === null) return;
    window.clearTimeout(readTimer.current);
    readTimer.current = null;
    writeChatPosition(storage, visitKey, readThrough.current);
  }

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        setVisitAfter(readChatPosition(storage, visitKey));
      } else {
        flushReadPosition();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushReadPosition);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushReadPosition);
      flushReadPosition();
    };
  }, [storage, visitKey]);

  function recordVisible(timeline: HTMLDivElement) {
    const feed = feedRef.current;
    if (feed === null || document.visibilityState !== 'visible') return;
    const viewport = timeline.getBoundingClientRect();
    learningAnchor.current = null;
    for (const element of feed.children) {
      if (element.querySelector('[data-slot="learning-notice"]') !== null) continue;
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
        learningAnchor.current = { element, top: bounds.top - viewport.top };
        break;
      }
    }
    const seq = visibleReadSequence(feed, viewport);
    if (seq <= readThrough.current) return;
    readThrough.current = seq;
    readTimer.current ??= window.setTimeout(flushReadPosition, 300);
  }

  function preserveLearningAnchor(timeline: HTMLDivElement) {
    const saved = learningAnchor.current;
    if (saved !== null && saved.element.isConnected) {
      timeline.scrollTop += saved.element.getBoundingClientRect().top - timeline.getBoundingClientRect().top - saved.top;
    }
    seenTop.current = timeline.scrollTop;
  }

  function leave() {
    if (leaving.current) return;
    leaving.current = true;
    if (readTimer.current !== null) window.clearTimeout(readTimer.current);
    readTimer.current = null;
    savedPositions.delete(visitKey);
    forgetChatVisit(storage, visitKey);
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
  const baseStart =
    floor ?? (controller.loaded ? (restored === undefined ? initialFloor(chat.items.length, WINDOW_INITIAL) : Math.min(restored.floor, chat.items.length)) : 0);
  const unreadIndex = controller.loaded && visitAfter !== undefined ? firstUnreadIndex(chat.items, visitAfter) : -1;
  const unreadTarget = unreadIndex < 0 ? undefined : chat.items[unreadIndex];
  const start = unreadIndex < 0 ? baseStart : Math.min(baseStart, unreadIndex);
  const markerId = unreadTarget?.id ?? unreadId;

  useEffect(() => {
    if (controller.loaded && floor === null) setFloor(start);
  }, [controller.loaded, floor, start]);

  const pendingQuestions = useMemo(
    () => chat.items.filter((item): item is UserQuestionItem => item.kind === 'user_question' && item.result === null && !item.unavailable),
    [chat.items],
  );
  const pendingFiles = useMemo(
    () => chat.items.filter((item): item is FileRequestItem => item.kind === 'file_request' && item.result === null && !item.unavailable),
    [chat.items],
  );
  const pendingCount = chat.permissions.length + pendingQuestions.length + pendingFiles.length;

  // Background work: the view the cards read their state from, the header chip count, and the nested tree of the
  // loaded window (children under their parent card; the node cache keeps unchanged rows memoized).
  const backgroundView = useMemo<BackgroundView>(
    () => ({ active: isActiveStatus(chat.status), turnEnds: chat.turnEnds }),
    [chat.status, chat.turnEnds],
  );
  const backgroundList = useMemo(() => backgroundEntries(chat.items, backgroundView), [chat.items, backgroundView]);
  const chipCount = backgroundChipCount(backgroundList, chat.turnEnds);
  /** What the header row, the "..." menu and the chips show. The rule is in chat/headerActions.ts. */
  const headerPlan = planHeaderActions({
    kind: current.kind,
    layout,
    loop: controller.loop,
    backgroundTotal: backgroundList.length,
    backgroundActive: chipCount,
  });
  const nodeCache = useRef<ReadonlyMap<string, ChatNode>>(new Map());
  const topNodes = useMemo(() => {
    const nested = nestItems(
      chat.items.slice(start),
      nodeCache.current,
    );
    nodeCache.current = nested.nodes;
    return nested.roots;
  }, [chat.items, start]);
  const toolRuns = useMemo(() => groupToolRuns(topNodes).filter((nodes) => {
    const item = nodes[0]?.item;
    return item === undefined || (item.kind !== 'user_question' && item.kind !== 'file_request') || item.result !== null || item.unavailable;
  }), [topNodes]);

  // The first render that has the history fixes what counts as history; everything appended later is live.
  useEffect(() => {
    if (controller.loaded && history === null) setHistory(historyOf(chat.items));
  }, [controller.loaded, history, chat.items]);

  // Antes da pintura: ancora o item visível depois de carregar anteriores, restaura a posição salva ou gruda no fim.
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    const previous = scrollSnapshot.current;
    scrollSnapshot.current = { items: chat.items, floor, start, pending: pendingCount, loaded: controller.loaded };
    if (previous !== null && previous.items !== chat.items) {
      quietLearningResize.current = isLearningOnlyChange(previous.items, chat.items);
    }
    if (quietLearningResize.current && previous !== null && previous.floor === floor && previous.start === start && previous.pending === pendingCount && previous.loaded === controller.loaded) {
      preserveLearningAnchor(timeline);
      recordVisible(timeline);
      return;
    }
    if (controller.loaded && visitAfter !== undefined && document.visibilityState === 'visible') {
      setVisitAfter(undefined);
      setUnreadId(unreadTarget?.id ?? null);
      const marker = unreadMarker.current;
      if (unreadTarget !== undefined && marker !== null) {
        if (start !== floor) setFloor(start);
        pendingRestore.current = undefined;
        timeline.scrollTop += marker.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 8;
        seenTop.current = timeline.scrollTop;
        const near = isNearBottom(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight);
        stick.current = near;
        setAtBottom(near);
        baseline.current = conversationCount;
        pendingCardCount.current = pendingCount;
        recordVisible(timeline);
        return;
      }
    }
    settleUserScroll(timeline);
    if (pendingCount > pendingCardCount.current) stick.current = true;
    pendingCardCount.current = pendingCount;

    const pendingAnchor = anchor.current;
    const saved = pendingRestore.current;
    if (pendingAnchor !== null) {
      anchor.current = null;
      const target = pendingAnchor.element.isConnected ? pendingAnchor.element
        : pendingAnchor.id === null ? null
          : timeline.querySelector(`[data-item-id="${CSS.escape(pendingAnchor.id)}"]`)?.closest('[data-slot="tool-activity-run"]');
      if (target !== null && target !== undefined) timeline.scrollTop += target.getBoundingClientRect().top - pendingAnchor.top;
    } else if (controller.loaded && saved !== undefined) {
      pendingRestore.current = undefined;
      stick.current = saved.atBottom;
      timeline.scrollTop = saved.atBottom ? timeline.scrollHeight : saved.top;
      setAtBottom(saved.atBottom);
    } else if (stick.current) {
      timeline.scrollTop = timeline.scrollHeight;
    }
    seenTop.current = timeline.scrollTop;
    if (controller.loaded) recordVisible(timeline);
  }, [controller.loaded, floor, chat.items, chat.permissions, pendingCount, visitAfter, unreadTarget, start]);

  /** A background row or answered question: render its history row, then scroll to its confirmed state. */
  function revealItem(id: string) {
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
      if (quietLearningResize.current) preserveLearningAnchor(timeline);
      if (stick.current && !quietLearningResize.current) timeline.scrollTop = timeline.scrollHeight;
      seenTop.current = timeline.scrollTop;
      recordVisible(timeline);
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
    anchor.current = element === undefined ? null : {
      element,
      id: element.getAttribute('data-item-id') ?? element.getAttribute('data-activity-id'),
      top: element.getBoundingClientRect().top,
    };
    setFloor(earlierFloor(start, WINDOW_STEP));
  }

  /** The "Ir para o fim" button: a smooth scroll the user asked for. Streaming follow (below) stays instant. */
  function jumpToEnd() {
    const timeline = timelineRef.current;
    if (timeline === null) return;
    quietLearningResize.current = false;
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
      if (!near) baseline.current = conversationCount;
    }
    if (floor !== null) {
      savedPositions.set(visitKey, { floor, top: timeline.scrollTop, atBottom: near });
      recordVisible(timeline);
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
    if (!canSend) return;

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

    const drafts = attachments.drafts;
    setSending(true);
    setSendError(null);
    if (drafts.length > 0) setProgress(0);
    try {
      const uploaded = await uploadFiles(
        drafts.map((draftItem) => draftItem.file),
        (file, onProgress) => controller.uploadAttachment(file, onProgress),
        setProgress,
      );
      await api.submitPrompt(current.id, text, uploaded.map((file) => file.fileId));
      if (textarea.current?.value === text) clearDraft();
      setSends((count) => count + 1);
      drafts.forEach(({ id }) => attachments.remove(id));
      setAttachNotice(null);
      stick.current = true;
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
    setCommandSheet(sheet);
    textarea.current?.blur();
  }

  /** Empties the composer after a send and leaves the history navigation (the next Up starts from the newest again). */
  function clearDraft() {
    setDraft('');
    setCaret(0);
    setHistoryCursor(IDLE_PROMPT_CURSOR);
  }

  function useMessageAsDraft(text: string, quote: boolean) {
    const next = insertMessageInDraft(savedDraft, text, quote);
    setHistoryCursor(IDLE_PROMPT_CURSOR);
    setDraft(next);
    setCaret(next.length);
    pendingCaret.current = next.length;
    textarea.current?.focus();
  }

  function messageActions(message: ActionMessage): ActionSheetItem[] {
    const text = message.kind === 'user_message'
      ? stripPromptNotes(message.text)
      : stripAnsi(splitLoopMarkers(message.text).text);
    const items: ActionSheetItem[] = [
      {
        label: t('messageActions.copy'),
        icon: Copy,
        keepsFocus: true,
        requiresActivation: true,
        onSelect: () => {
          void copyText(text).then((copied) =>
            setMessageNotice(t(copied ? 'messageActions.copied' : 'messageActions.copyFailed')),
          );
        },
      },
      { label: t('messageActions.quote'), icon: Quote, onSelect: () => useMessageAsDraft(text, true) },
    ];
    if (message.kind === 'user_message') {
      items.push({
        label: t('messageActions.reuse'),
        icon: Pencil,
        ...(savedDraft.trim() === '' ? {} : { detail: t('messageActions.appendDetail') }),
        onSelect: () => useMessageAsDraft(text, false),
      });
    }
    return items;
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
    setSendError(null);
    void api.submitPrompt(current.id, text, [])
      .then(() => { stick.current = true; })
      .catch(setSendError);
  }

  /** Puts `/<text> ` before the composer text and focuses it. The tap is a user gesture, so the keyboard opens. */
  function insertCommandText(text: string) {
    const next = insertCommand(draft, 0, text, 'prefix');
    setHistoryCursor(IDLE_PROMPT_CURSOR);
    setDraft(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    textarea.current?.focus();
  }

  /**
   * Sends a config change from any control (the chip, the settings drawer, the command picker). A switch into a dangerous
   * work mode waits for the user's OK; the settings drawer closes first so the confirmation is the only sheet open.
   */
  function changeConfig(option: SessionConfigOption, value: ConfigValue) {
    if (typeof value === 'string' && isDangerousSwitch(option, value, current.agent)) {
      setConfigOpen(false);
      setPendingDanger({ configId: option.id, value });
      return;
    }
    controller.setConfig(option.id, value);
  }

  function confirmDangerSwitch() {
    if (pendingDanger === null) return;
    controller.setConfig(pendingDanger.configId, pendingDanger.value);
    setPendingDanger(null);
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
            changeConfig(option, choice.value);
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
    setHistoryCursor(IDLE_PROMPT_CURSOR);
    // A `/loop` picked from the menu opens the Loop mode sheet. Typed text is handled the same way as for other commands.
    if (command.name === 'loop') {
      setDraft(draft.slice(caret).replace(/^ /, ''));
      setCaret(0);
      openLoop();
      return;
    }
    const sheet = commandSheetFor(command, controller.configOptions);
    if (sheet !== undefined) {
      setDraft(draft.slice(caret).replace(/^ /, ''));
      setCaret(0);
      openCommandSheet(sheet);
      return;
    }
    const next = insertCommand(draft, caret, command.name, 'typed');
    setDraft(next.text);
    setCaret(next.caret);
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
  const waitingForQuestion = chat.status === 'running' && chat.permissions.length === 0 && pendingQuestions.length > 0;
  const waitingForFile = chat.status === 'running' && chat.permissions.length === 0 && pendingFiles.length > 0;
  // The line above the composer. `idle` has none.
  const working = controller.resuming
    ? t('working.resuming')
    : chat.status === 'running' && chat.permissions.length > 0
      ? t('working.awaiting_permission')
      : waitingForFile
        ? t('fileRequest.waiting')
        : waitingForQuestion
          ? t('question.waiting')
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
  const unseen = unseenSince(baseline.current, conversationCount);
  const hasContent = draft.trim() !== '' || attachments.drafts.length > 0;
  const queueing = queuesPrompt(chat.status);
  const canSend = (acceptsPrompt(chat.status) || queueing) && hasContent && !sending && !dictating;
  const sendLabel = sending ? t('composer.sending') : queueing ? t('composer.queue') : t('composer.send');
  const menuQuery = inputEnabled ? slashQuery(draft, caret) : undefined;
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
      const completing = menuQuery !== undefined ? commandForEnter(controller.commands, menuQuery) : undefined;
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

  /** The "..." menu's rows, from the plan. The labels and details are in chat/headerMenuRows.ts. */
  const menuRows = headerMenuRows(headerPlan.sheet, controller.loop, {
    openUsage: () => setUsageOpen(true),
    openLoop,
    openBackground: () => setBackgroundOpen(true),
    openHistory: () => nav.push({ kind: 'commits', workspace, session: current }),
    remove: () => setRemoving(true),
  });

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
            {headerPlan.row.includes('files') && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sessions.files', { ns: 'workspace' })}
                title={t('sessions.files', { ns: 'workspace' })}
                onClick={() => nav.push({ kind: 'files', workspace, path: '' })}
              >
                <FolderTree aria-hidden="true" />
              </Button>
            )}
            {headerPlan.row.includes('terminal') && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sessions.terminal', { ns: 'workspace' })}
                title={t('sessions.terminal', { ns: 'workspace' })}
                onClick={() => setShellOpen(true)}
              >
                <SquareTerminal aria-hidden="true" />
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
              items={menuRows}
            />
          </header>
            {/* The place line has its own row under the title, indented to the title. The chips sit at its end: the work mode's when the agent has modes, the loop's while it runs or stopped on an error, the background work's while it runs. */}
            <div className={cn('-mt-1 flex min-w-0 items-center gap-2 pr-1', backAffordance === 'back' ? 'pl-[62px]' : 'pl-[22px]')}>
              <PlaceLine text={place} />
              {current.kind === 'acp' && (
                <WorkModeChip
                  option={modeOption}
                  agentId={current.agent}
                  disabled={!acceptsConfigChange(chat.status)}
                  onPick={(value) => {
                    if (modeOption !== undefined) changeConfig(modeOption, value);
                  }}
                  yolo={{ enabled: controller.yolo, onChange: controller.setYolo }}
                />
              )}
              {headerPlan.chips.loop && <LoopChip loop={controller.loop} onOpen={openLoop} />}
              {/* 44px tap area around a 24px pill; the negative margins keep the header's height unchanged. */}
              {headerPlan.chips.background && (
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
              revealItem(id);
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

          {pendingDanger !== null && (
            <WorkModeConfirmSheet onCancel={() => setPendingDanger(null)} onConfirm={confirmDangerSwitch} />
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
                          onChange={(value) => changeConfig(control.option, value)}
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
            {sendError instanceof ApiError && sendError.code === 'prompt_queue_full'
              ? <ErrorNotice message={t('queue.full')} />
              : <ErrorNotice error={sendError} onRepair={onRepair} />}

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
                {toolRuns.map((nodes) => {
                  const node = nodes[0];
                  if (node === undefined) return null;
                  const activity = node.item.kind === 'tool_call';
                  return (
                    <div
                      key={node.item.id}
                      data-item-id={activity ? undefined : node.item.id}
                      data-activity-id={activity ? node.item.id : undefined}
                      data-readable-seq={readableSequence(node.item)}
                      className={cn(ITEM_FRAME_CLASS, arrivedLive(history, node.item.id) && 'animate-enter motion-reduce:animate-none')}
                    >
                      {node.item.id === markerId && (
                        <div
                          ref={unreadMarker}
                          data-slot="unread-marker"
                          className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
                        >
                          {t('timeline.newMessages')}
                        </div>
                      )}
                      {activity ? (
                        <ToolActivity nodes={nodes} view={backgroundView} history={history}
                          renderNode={(child) => <ChatItemView node={child} api={api} view={backgroundView} nested history={history} onOpenPreview={controller.openPreview} onClosePreview={controller.closePreview} workspaceId={current.workspaceId} onManageLearning={controller.manageLearningReview} />} />
                      ) : (
                        <ChatItemView node={node} api={api} view={backgroundView} history={history} onMessageActions={setActionsMessage} onOpenPreview={controller.openPreview} onClosePreview={controller.closePreview} workspaceId={current.workspaceId} onManageLearning={controller.manageLearningReview} />
                      )}
                    </div>
                  );
                })}
              </div>
              {pendingQuestions.map((request) => (
                <div key={request.requestId} className="wide:w-full wide:max-w-[1040px]">
                  <UserQuestionCard
                    request={request}
                    onRespond={async (optionId) => {
                      const result = await controller.answerUserQuestion(request.requestId, optionId);
                      revealItem(request.id);
                      return result;
                    }}
                  />
                </div>
              ))}
              {pendingFiles.map((request) => (
                <div key={request.requestId} className="min-w-0 max-w-full wide:w-full wide:max-w-[1040px]">
                  <FileRequestCard
                    api={api}
                    request={request}
                    onUpload={controller.uploadAttachment}
                    onRespond={async (fileId) => {
                      const result = await controller.answerFileRequest(request.requestId, fileId);
                      revealItem(request.id);
                      return result;
                    }}
                  />
                </div>
              ))}
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
            {messageNotice !== null && <p role="status" className="text-sm text-muted-foreground">{messageNotice}</p>}
            {plan !== undefined && <PlanDock key={current.id} entries={plan.entries} />}
            {working !== undefined && (
              <div
                role="status"
                className="flex min-h-11 shrink-0 animate-enter items-center gap-2.5 pl-1 text-sm text-muted-foreground motion-reduce:animate-none"
              >
                {controller.resuming ? (
                  <LoaderCircle className="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none" aria-hidden="true" />
                ) : waitingForQuestion ? (
                  <MessageCircleQuestion className="size-4 shrink-0" aria-hidden="true" />
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

            {controller.promptQueue.length > 0 && (
              <section aria-label={t('queue.title')} data-slot="prompt-queue" className="origin-bottom rounded-lg border border-border bg-card motion-safe:animate-enter-scale">
                <p role="status" className="px-3 pt-2 text-xs font-medium text-muted-foreground">
                  {t('queue.count', { count: controller.promptQueue.length })}
                </p>
                <ol className="max-h-32 divide-y divide-border overflow-y-auto">
                  {controller.promptQueue.map((item) => (
                    <li key={item.id} className="flex min-w-0 items-center gap-1 pl-3 pr-1">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">{item.preview || t('queue.attachments', { count: item.attachments })}</p>
                        {item.failed && <p className="text-xs text-destructive">{t('queue.failed')}</p>}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('queue.remove')}
                        onClick={() => {
                          setSendError(null);
                          void api.removeQueuedPrompt(current.id, item.id).catch(setSendError);
                        }}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ol>
              </section>
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
              <SlashMenu commands={controller.commands} query={menuQuery} onPick={pickCommand} />
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

            {dictating && (
              <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
                <span role="status">
                  {dictation.stage === 'recording'
                    ? t('transcription.recording', { seconds: dictation.elapsed })
                    : t(`transcription.${dictation.stage === 'starting' ? 'starting' : 'transcribing'}`)}
                </span>
                <Button type="button" variant="ghost" size="icon" data-slot="dictation-cancel" aria-label={t('transcription.cancel')} onClick={dictation.cancel}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            )}
            {dictation.failure !== null && (
              <p data-slot="dictation-error" role="alert" className="pb-1 text-sm text-destructive">{t(`transcription.${dictation.failure}`)}</p>
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
              <textarea
                ref={textarea}
                data-slot="chat-textarea"
                rows={1}
                value={draft}
                placeholder={placeholder}
                disabled={!composerOpen}
                onChange={(event) => {
                  setHistoryCursor(IDLE_PROMPT_CURSOR);
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
              {(transcriptionStatus?.state === 'ready' || dictating) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t(dictation.stage === 'recording' ? 'transcription.stop' : 'transcription.start')}
                  data-slot="dictation-button"
                  className={cn('text-muted-foreground', dictation.stage === 'recording' && 'text-destructive')}
                  disabled={dictation.stage !== 'recording' && (!composerOpen || sending || dictating)}
                  onClick={() => void (dictation.stage === 'recording' ? dictation.stop() : dictation.start())}
                >
                  {dictation.stage === 'recording' ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
                </Button>
              )}
              {/* Keyed by the send count: each send remounts the button, so it pops once. Enabled and disabled fade in the base button. */}
              <Button
                key={sends}
                type="submit"
                size="icon"
                aria-label={sendLabel}
                title={sendLabel}
                className={cn('rounded-full', sends > 0 && 'animate-pop motion-reduce:animate-none')}
                disabled={!canSend}
              >
                <Send aria-hidden="true" />
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

          {actionsMessage !== null && (
            <ActionSheet
              label={t('messageActions.title')}
              title={t('messageActions.title')}
              items={messageActions(actionsMessage)}
              onClose={() => setActionsMessage(null)}
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
