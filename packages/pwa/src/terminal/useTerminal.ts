import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { Session, SessionEvent } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { loadHistory } from '../chat/history.js';
import { OFFLINE_NOTICE } from '../chat/useChat.js';
import type { Connection } from '../connection.js';
import { sendTerminalInput } from './input.js';
import { createResizeScheduler, RESIZE_DEBOUNCE_MS } from './resize.js';
import { TERMINAL_OPTIONS } from './options.js';
import { createTerminalState, ingestTerminal, type TerminalExit } from './output.js';

export type CopyResult = 'copied' | 'empty' | 'failed';

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
  /** Envia bytes ao PTY. `false` se não enviou (sem conexão). */
  input(data: string): boolean;
  /** Ajusta o xterm ao espaço da tela; envia o tamanho ao daemon com debounce. */
  requestFit(): void;
  /** Copia a seleção do xterm para a área de transferência. */
  copySelection(): Promise<CopyResult>;
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
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => undefined);

  const inputOpen = exit === null && session.status !== 'stopped' && session.status !== 'error';
  // Lido pelo agendador de resize: terminal encerrado não recebe tamanho (o daemon responderia erro).
  const liveRef = useRef(inputOpen);
  useEffect(() => {
    liveRef.current = inputOpen;
  }, [inputOpen]);

  const input = useCallback(
    (data: string): boolean => {
      const sent = sendTerminalInput((message) => connection?.send(message) ?? false, sessionId, data);
      if (!sent) setNotice(OFFLINE_NOTICE);
      return sent;
    },
    [connection, sessionId],
  );

  useEffect(() => {
    if (container === null) return;
    let active = true;

    const term = new Terminal(TERMINAL_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Mede antes do replay: o histórico é escrito já na largura da tela. Escrito em 80 colunas e só depois
    // redimensionado, o redesenho do PowerShell (↑, Enter) saía sobreposto e o replay ficava diferente.
    fit.fit();
    termRef.current = term;

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
    const onWindowResize = () => resize.request();
    window.addEventListener('resize', onWindowResize);

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
      resize.dispose();
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
    requestFit,
    copySelection,
  };
}
