import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Session, SessionEvent } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { getBrowserStorage } from '../browserStorage.js';
import { loadHistory } from '../chat/history.js';
import { offlineNotice } from '../chat/useChat.js';
import { ENTER_SENDS_QUERY, WIDE_QUERY } from '../wide/layout.js';
import type { Connection } from '../connection.js';
import { attachTouchScroll, cellHeightOf } from './attachTouchScroll.js';
import { clampFontSize, readFontSize, writeFontSize } from './fontSize.js';
import { sendTerminalInput } from './input.js';
import { applySticky, hasSticky, isUserKey, NO_STICKY_KEYS, type StickyKeys } from './modifiers.js';
import { createResizeScheduler, RESIZE_DEBOUNCE_MS } from './resize.js';
import { TERMINAL_OPTIONS } from './options.js';
import { createTerminalState, ingestTerminal, type TerminalExit } from './output.js';

export type CopyResult = 'copied' | 'empty' | 'failed';
export type PasteResult = 'pasted' | 'empty' | 'failed';

export interface TerminalOptions {
  api: ApiClient;
  /** Conexão da máquina; sem ela o terminal mostra só o que já foi carregado. */
  connection: Connection | undefined;
  session: Session;
}

export interface TerminalController {
  /** Sessão mais recente (status vindo do broadcast `session`). */
  session: Session;
  /** Ref do elemento onde o xterm é montado. */
  setContainer(element: HTMLDivElement | null): void;
  loaded: boolean;
  loadError: unknown;
  /** Processo encerrado (evento `terminal_exit`), ou null. */
  exit: TerminalExit | null;
  /** Entrada liberada: processo ainda vivo e sessão não parada. */
  inputOpen: boolean;
  notice: string | null;
  dismissNotice(): void;
  /** Envia bytes ao PTY, com as travas Ctrl/Alt aplicadas à primeira tecla. `false` se não enviou (sem conexão). */
  input(data: string): boolean;
  /** Travas Ctrl e Alt ligadas, aguardando a próxima tecla. */
  sticky: StickyKeys;
  toggleSticky(key: 'ctrl' | 'alt'): void;
  /** Tamanho da fonte do xterm (preferência deste aparelho). */
  fontSize: number;
  changeFontSize(size: number): void;
  /** Ajusta o xterm ao espaço da tela; envia o tamanho ao daemon com debounce. */
  requestFit(): void;
  /** Copia a seleção do xterm para a área de transferência. */
  copySelection(): Promise<CopyResult>;
  /** Cola o texto da área de transferência no terminal. */
  paste(): Promise<PasteResult>;
  /** O histórico está rolado para cima (há saída mais nova abaixo da área visível). */
  scrolledUp: boolean;
  /** Volta para o fim da saída (o botão "Ir para o fim"). */
  scrollToEnd(): void;
}

/**
 * Sessão PTY no navegador: monta o xterm, carrega o histórico de saída, assina o WS a partir
 * do último seq (sem duplicar no replay) e manda entrada e resize ao daemon.
 */
export function useTerminal({ api, connection, session: initial }: TerminalOptions): TerminalController {
  const sessionId = initial.id;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [session, setSession] = useState(initial);
  const [exit, setExit] = useState<TerminalExit | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sticky, setSticky] = useState<StickyKeys>(NO_STICKY_KEYS);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [fontSize, setFontSize] = useState(() => readFontSize(getBrowserStorage()));
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => undefined);
  // Lidos pelas funções de entrada e de criação do xterm: estado de tela que não deve recriar o terminal.
  const stickyRef = useRef<StickyKeys>(NO_STICKY_KEYS);
  const fontSizeRef = useRef(fontSize);

  const inputOpen = exit === null && session.status !== 'stopped' && session.status !== 'error';
  // Lido pelo agendador de resize: terminal encerrado não recebe tamanho (o daemon responderia erro).
  const liveRef = useRef(inputOpen);
  useEffect(() => {
    liveRef.current = inputOpen;
  }, [inputOpen]);

  const input = useCallback(
    (data: string): boolean => {
      const keys = stickyRef.current;
      // Relatórios de foco do xterm passam direto: não são digitação, então não gastam Ctrl/Alt.
      const user = isUserKey(data);
      const payload = user ? applySticky(data, keys) : data;
      if (user && hasSticky(keys)) {
        stickyRef.current = NO_STICKY_KEYS;
        setSticky(NO_STICKY_KEYS);
      }
      const sent = sendTerminalInput((message) => connection?.send(message) ?? false, sessionId, payload);
      if (!sent) setNotice(offlineNotice());
      return sent;
    },
    [connection, sessionId],
  );

  useEffect(() => {
    if (container === null) return;
    let active = true;

    const term = new Terminal({ ...TERMINAL_OPTIONS, fontSize: fontSizeRef.current });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Mede antes do replay: o histórico é escrito já na largura da tela. Escrito em 80 colunas e só depois
    // redimensionado, o redesenho do PowerShell (↑, Enter) saía sobreposto e o replay ficava diferente.
    fit.fit();
    termRef.current = term;
    // A mouse and keyboard type straight into the terminal; on a phone focusing it would open the keyboard unasked.
    if (window.matchMedia(ENTER_SENDS_QUERY).matches) term.focus();
    // Rolagem por toque (o xterm não rola o histórico com o dedo no iOS) e o estado do botão "Ir para o fim".
    const detachTouch = attachTouchScroll(container, term, () => cellHeightOf(container, term));
    container.style.touchAction = 'none';
    container.style.overscrollBehavior = 'contain';
    const refreshScrolledUp = (): void => {
      const buffer = term.buffer.active;
      setScrolledUp(buffer.viewportY < buffer.baseY);
    };
    const scrollListener = term.onScroll(refreshScrolledUp);
    const writeListener = term.onWriteParsed(refreshScrolledUp);

    const resize = createResizeScheduler({
      delayMs: RESIZE_DEBOUNCE_MS,
      measure: () => {
        fit.fit();
        return { cols: term.cols, rows: term.rows };
      },
      send: (size) => connection?.send({ type: 'terminal_resize', sessionId, ...size }) ?? false,
      canSend: () => liveRef.current,
    });
    fitRef.current = () => resize.request();
    resize.request();
    // iOS: a rotação dispara resize; o orientationchange cobre o caso em que o resize chega antes do layout.
    const onWindowResize = () => resize.request();
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);
    // Wide screens: the pane can change size while the window does not (the third pane opening beside a terminal).
    const paneObserver =
      typeof ResizeObserver !== 'undefined' && window.matchMedia(WIDE_QUERY).matches ? new ResizeObserver(onWindowResize) : null;
    paneObserver?.observe(container);

    term.onData((data) => {
      input(data);
    });

    let store = createTerminalState();
    const apply = (events: readonly SessionEvent[]) => {
      const result = ingestTerminal(store, events);
      store = result.state;
      for (const data of result.writes) term.write(data);
      setExit(result.state.exit);
    };

    const off = connection?.onMessage((message) => {
      if (message.type === 'event') {
        if (message.event.sessionId === sessionId) apply([message.event]);
      } else if (message.type === 'session') {
        if (message.session.id === sessionId) setSession(message.session);
      } else if (message.type === 'error') {
        if (message.sessionId === undefined || message.sessionId === sessionId) {
          setNotice(message.message);
        }
      } else if (message.type === 'hello') {
        // Reconectou: o daemon pode não ter o último tamanho enviado (ficou offline). Manda de novo.
        resize.forget();
        resize.request();
      }
    });

    loadHistory((after, limit) => api.fetchEvents(sessionId, { after, limit }), 0)
      .then((events) => {
        if (!active) return;
        apply(events);
        connection?.subscribe(sessionId, store.lastSeq);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error);
      });

    return () => {
      active = false;
      off?.();
      connection?.unsubscribe(sessionId);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('orientationchange', onWindowResize);
      paneObserver?.disconnect();
      resize.dispose();
      detachTouch();
      scrollListener.dispose();
      writeListener.dispose();
      container.style.touchAction = '';
      container.style.overscrollBehavior = '';
      setScrolledUp(false);
      fitRef.current = () => undefined;
      termRef.current = null;
      term.dispose();
    };
  }, [api, connection, container, input, sessionId]);

  // Entrada desligada (processo morto ou sessão parada): o xterm não aceita digitação.
  useEffect(() => {
    const term = termRef.current;
    if (term !== null) term.options.disableStdin = !inputOpen;
  }, [container, inputOpen]);

  const requestFit = useCallback(() => fitRef.current(), []);

  const toggleSticky = useCallback((key: 'ctrl' | 'alt') => {
    const current = stickyRef.current;
    const next = key === 'ctrl' ? { ctrl: !current.ctrl, alt: current.alt } : { ctrl: current.ctrl, alt: !current.alt };
    stickyRef.current = next;
    setSticky(next);
  }, []);

  const changeFontSize = useCallback((size: number) => {
    const next = clampFontSize(size);
    fontSizeRef.current = next;
    writeFontSize(getBrowserStorage(), next);
    setFontSize(next);
  }, []);

  // Tamanho novo: o xterm refaz as medidas (e o fit manda as novas colunas e linhas ao daemon).
  useEffect(() => {
    const term = termRef.current;
    if (term === null) return;
    term.options.fontSize = fontSize;
    fitRef.current();
  }, [fontSize]);

  const scrollToEnd = useCallback(() => {
    termRef.current?.scrollToBottom();
  }, []);

  const copySelection = useCallback(async (): Promise<CopyResult> => {
    const text = termRef.current?.getSelection() ?? '';
    if (text === '') return 'empty';
    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return 'failed';
    }
  }, []);

  const paste = useCallback(async (): Promise<PasteResult> => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return 'failed';
    }
    if (text === '') return 'empty';
    return input(text) ? 'pasted' : 'failed';
  }, [input]);

  return {
    session,
    setContainer,
    loaded,
    loadError,
    exit,
    inputOpen,
    notice,
    dismissNotice: () => setNotice(null),
    input,
    sticky,
    toggleSticky,
    fontSize,
    changeFontSize,
    requestFit,
    copySelection,
    paste,
    scrolledUp,
    scrollToEnd,
  };
}
