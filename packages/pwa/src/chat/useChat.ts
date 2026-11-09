import { useEffect, useState } from 'react';
import type {
  AskUserResult,
  AvailableCommand,
  ClientMessage,
  ConfigValue,
  FileInfo,
  Loop,
  LoopRequest,
  QueuedPrompt,
  RequestFileResult,
  PreviewOpenResponse,
  Session,
  SessionConfigOption,
  SessionEvent,
} from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import type { Connection } from '../connection.js';
import { writeAgentConfig } from '../agentConfig.js';
import { t } from '../i18n/index.js';
import type { StorageLike } from '../machines.js';
import { applyAccountReply } from './accountReply.js';
import { applyEvents, createChatState, withStatus, withUserQuestionResult, withFileRequestResult, withPreviewClosed, withLearningNotice, type ChatState } from './reducer.js';
import { loadHistory } from './history.js';
import { pickLoop } from './loop.js';
import { createFrameBatcher } from './frameBatch.js';

/** Notice for an action that needs the connection to the PC, in the current language. */
export function offlineNotice(): string {
  return t('chat:offline');
}

export interface ChatOptions {
  api: ApiClient;
  /** Conexão da máquina; sem ela o chat mostra só o histórico carregado. */
  connection: Connection | undefined;
  storage: StorageLike;
  session: Session;
}

export interface ChatController {
  chat: ChatState;
  /** Sessão mais recente (título e status vindos do broadcast `session`). */
  session: Session;
  /** Comandos do agente: carregados por GET ao abrir e atualizados pela mensagem `commands`. */
  commands: readonly AvailableCommand[];
  /** Opções de configuração (modelo, effort, modo...): GET ao abrir, depois a mensagem `config_options`. */
  configOptions: readonly SessionConfigOption[];
  loaded: boolean;
  loadError: unknown;
  notice: string | null;
  dismissNotice(): void;
  /** Retomada em andamento (POST resume). */
  resuming: boolean;
  /** Erro da última tentativa de retomar, ou null. */
  resumeError: unknown;
  /** Sobe o agente da sessão parada. Em sucesso, aplica a sessão devolvida (o broadcast também chega). */
  resume(): Promise<void>;
  /** Sobe um anexo do celular para a sessão; o resultado vai no `attachments` do prompt. */
  uploadAttachment(file: File, onProgress: (fraction: number) => void): Promise<FileInfo>;
  /** Retorna `false` se não enviou (sem texto e sem anexo, ou sem conexão). */
  sendPrompt(text: string, attachments?: readonly FileInfo[]): boolean;
  cancel(): boolean;
  respond(requestId: string, optionId: string): boolean;
  /** HTTP confirmation updates history even when the WebSocket is temporarily disconnected. */
  answerUserQuestion(requestId: string, optionId: string | null): Promise<AskUserResult>;
  answerFileRequest(requestId: string, fileId: string | null): Promise<RequestFileResult>;
  openPreview(previewId: string): Promise<PreviewOpenResponse>;
  closePreview(previewId: string): Promise<void>;
  manageLearningReview(reviewId: string, action: 'approve' | 'reject' | 'revert'): Promise<void>;
  setConfig(configId: string, value: ConfigValue): boolean;
  yolo: boolean;
  setYolo(enabled: boolean): boolean;
  promptQueue: readonly QueuedPrompt[];
  /**
   * Moves the session to another account (`default` = principal): the daemon stops the agent and resumes it there.
   * Applies the session it answers with, except its status (the WebSocket reports that). A failure throws the `ApiError` (see `describeAccountError`).
   */
  setAccount(accountId: string): Promise<void>;
  /** The session's loop (Loop mode): GET on open, then the WS `loop` message. Null when there is no loop. */
  loop: Loop | null;
  /** The first loop state has arrived (GET or WS). Until then the chip and the sheet claim nothing. */
  loopLoaded: boolean;
  /** A loop action is running. */
  loopBusy: boolean;
  /** Loop actions throw the `ApiError` when they fail (see `describeLoopError`); the state comes from the response. */
  saveLoop(request: LoopRequest): Promise<void>;
  pauseLoop(): Promise<void>;
  resumeLoop(): Promise<void>;
  runLoopNow(): Promise<void>;
  /** Stops and deletes the loop. */
  stopLoop(): Promise<void>;
}

/**
 * Estado de uma sessão aberta no chat: carrega o histórico por HTTP, assina o WS a partir
 * do último seq carregado (sem corrida entre histórico e ao vivo) e aplica os eventos
 * pelo reducer. Também guarda a última config do agente no storage.
 */
export function useChat({ api, connection, storage, session: initial }: ChatOptions): ChatController {
  const sessionId = initial.id;
  const [chat, setChat] = useState(() => createChatState(initial.status));
  const [session, setSession] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>(null);
  const [commands, setCommands] = useState<readonly AvailableCommand[]>([]);
  const [configOptions, setConfigOptions] = useState<readonly SessionConfigOption[]>([]);
  const [yolo, setYolo] = useState(false);
  const [promptQueue, setPromptQueue] = useState<readonly QueuedPrompt[]>([]);
  const [loop, setLoop] = useState<Loop | null>(null);
  const [loopLoaded, setLoopLoaded] = useState(false);
  const [loopBusy, setLoopBusy] = useState(false);

  useEffect(() => {
    let active = true;
    // A mensagem `commands` do WS é sempre mais nova que o GET em voo: se ela chegou, o GET não sobrescreve.
    let commandsFromSocket = false;
    // Mesma regra para as opções: a mensagem `config_options` vence o GET que estava em voo.
    let configFromSocket = false;
    // Streaming manda um evento por chunk: os eventos do mesmo quadro viram um único setState.
    const batcher = createFrameBatcher<SessionEvent>({
      schedule: (callback) => window.requestAnimationFrame(callback),
      cancel: (handle) => window.cancelAnimationFrame(handle),
      flush: (batch) => setChat((previous) => applyEvents(previous, batch)),
    });
    const off = connection?.onMessage((message) => {
      if (message.type === 'event') {
        if (message.event.sessionId === sessionId) {
          batcher.push(message.event);
        }
      } else if (message.type === 'session') {
        if (message.session.id === sessionId) {
          const next = message.session;
          setSession(next);
          setChat((previous) => withStatus(previous, next.status));
        }
      } else if (message.type === 'commands') {
        if (message.sessionId === sessionId) {
          commandsFromSocket = true;
          setCommands(message.commands);
        }
      } else if (message.type === 'config_options') {
        if (message.sessionId === sessionId) {
          configFromSocket = true;
          setConfigOptions(message.configOptions);
        }
      } else if (message.type === 'loop') {
        if (message.sessionId === sessionId) {
          applyLoop(message.loop);
        }
      } else if (message.type === 'yolo') {
        if (message.sessionId === sessionId) setYolo(message.enabled);
      } else if (message.type === 'prompt_queue') {
        if (message.sessionId === sessionId) setPromptQueue(message.queue);
      } else if (message.type === 'error') {
        if (message.sessionId === undefined || message.sessionId === sessionId) {
          setNotice(message.message);
        }
      }
    });

    // Falha do GET não tem aviso: o subscribe manda a lista de novo se ela existir.
    api
      .sessionCommands(sessionId)
      .then((list) => {
        if (active && !commandsFromSocket) setCommands(list);
      })
      .catch(() => undefined);

    api
      .sessionConfigOptions(sessionId)
      .then((list) => {
        if (active && !configFromSocket) setConfigOptions(list);
      })
      .catch(() => undefined);

    // A failed loop GET is not shown: the subscribe still sends the `loop` message.
    api
      .fetchLoop(sessionId)
      .then((current) => {
        if (active) applyLoop(current);
      })
      .catch(() => undefined);

    loadHistory((after, limit) => api.fetchEvents(sessionId, { after, limit }), 0)
      .then((events) => {
        if (!active) return;
        const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
        setChat((previous) => {
          const next = applyEvents(previous, events);
          return previous.status === 'stopped' || previous.status === 'error' ? withStatus(next, previous.status) : next;
        });
        connection?.subscribe(sessionId, lastSeq);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error);
      });

    return () => {
      active = false;
      off?.();
      batcher.dispose();
      connection?.unsubscribe(sessionId);
    };
  }, [api, connection, sessionId]);

  useEffect(() => {
    let expiresAt = Infinity;
    for (const item of chat.items) {
      if (item.kind === 'file_request' && item.result === null && !item.unavailable) expiresAt = Math.min(expiresAt, item.expiresAt);
    }
    if (expiresAt === Infinity) return;
    const expire = () => {
      const now = Date.now();
      setChat((previous) => {
        let next = previous;
        for (const item of previous.items) {
          if (item.kind === 'file_request' && item.result === null && !item.unavailable && item.expiresAt <= now) {
            next = withFileRequestResult(next, item.requestId, null);
          }
        }
        return next;
      });
    };
    const timer = window.setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    document.addEventListener('visibilitychange', expire);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', expire); };
  }, [chat.items]);

  useEffect(() => {
    if (configOptions.length > 0) {
      writeAgentConfig(storage, session.agent, configOptions);
    }
  }, [storage, session.agent, configOptions]);

  function send(message: ClientMessage): boolean {
    if (connection?.send(message) === true) return true;
    setNotice(offlineNotice());
    return false;
  }

  /** Applies a loop snapshot unless a newer one is already there (see `pickLoop`). */
  function applyLoop(next: Loop | null): void {
    setLoop((current) => pickLoop(current, next));
    setLoopLoaded(true);
  }

  /** One loop action: marks busy, applies the loop from the response, and lets the error reach the caller. */
  async function loopCall(action: () => Promise<Loop | null>): Promise<void> {
    setLoopBusy(true);
    try {
      applyLoop(await action());
    } finally {
      setLoopBusy(false);
    }
  }

  function refreshEvents(): void {
    void loadHistory((after, limit) => api.fetchEvents(sessionId, { after, limit }), chat.lastSeq)
      .then((events) => setChat((previous) => applyEvents(previous, events)))
      .catch(() => undefined);
  }

  function isStale(error: unknown): boolean {
    return error instanceof ApiError && error.status !== null && [404, 409, 410].includes(error.status);
  }

  return {
    chat,
    session,
    commands,
    configOptions,
    loaded,
    loadError,
    notice,
    dismissNotice: () => setNotice(null),
    resuming,
    resumeError,
    async manageLearningReview(reviewId, action) {
      const result = action === 'reject'
        ? await api.rejectLearningReview(session.workspaceId, reviewId)
        : await api.manageLearningReview(session.workspaceId, reviewId, action);
      setChat((previous) => withLearningNotice(previous, result));
    },


    async resume() {
      setResuming(true);
      setResumeError(null);
      try {
        const next = await api.resumeSession(sessionId);
        setSession(next);
        setChat((previous) => withStatus(previous, next.status));
      } catch (error: unknown) {
        setResumeError(error);
      } finally {
        setResuming(false);
      }
    },

    uploadAttachment(file, onProgress) {
      return api.uploadAttachment(sessionId, file, onProgress);
    },

    sendPrompt(text, attachments = []) {
      const trimmed = text.trim();
      if (trimmed === '' && attachments.length === 0) return false;
      const attachmentIds = attachments.map((file) => file.fileId);
      return send({
        type: 'prompt',
        sessionId,
        text: trimmed,
        ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
      });
    },

    cancel() {
      return send({ type: 'cancel', sessionId });
    },

    respond(requestId, optionId) {
      return send({ type: 'permission_response', sessionId, requestId, optionId });
    },

    async answerUserQuestion(requestId, optionId) {
      try {
        const result = await api.answerUserQuestion(sessionId, requestId, optionId);
        setChat((previous) => withUserQuestionResult(previous, requestId, result));
        return result;
      } catch (error: unknown) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 409 || error.status === 410)) {
          setChat((previous) => withUserQuestionResult(previous, requestId, null));
          setNotice(t('chat:question.unavailable'));
          // Another phone may have answered while this one was offline. Do not retry the write or infer its choice.
          void loadHistory((after, limit) => api.fetchEvents(sessionId, { after, limit }), chat.lastSeq)
            .then((events) => setChat((previous) => applyEvents(previous, events)))
            .catch(() => undefined);
        }
        throw error;
      }
    },

    async answerFileRequest(requestId, fileId) {
      try {
        const result = await api.respondFileRequest(sessionId, requestId, fileId);
        setChat((previous) => withFileRequestResult(previous, requestId, result));
        return result;
      } catch (error: unknown) {
        if (isStale(error)) {
          setChat((previous) => withFileRequestResult(previous, requestId, null));
          setNotice(t('chat:fileRequest.unavailable'));
          refreshEvents();
        }
        throw error;
      }
    },

    async openPreview(previewId) {
      try {
        return await api.openPreview(sessionId, previewId);
      } catch (error: unknown) {
        if (isStale(error)) {
          setChat((previous) => withPreviewClosed(previous, previewId, null));
          refreshEvents();
        }
        throw error;
      }
    },

    async closePreview(previewId) {
      try {
        await api.closePreview(sessionId, previewId);
        setChat((previous) => withPreviewClosed(previous, previewId, 'closed'));
      } catch (error: unknown) {
        if (isStale(error)) {
          setChat((previous) => withPreviewClosed(previous, previewId, null));
          refreshEvents();
        }
        throw error;
      }
    },

    setConfig(configId, value) {
      return send({ type: 'set_config', sessionId, configId, value });
    },

    yolo,
    promptQueue,
    setYolo(enabled) {
      return send({ type: 'set_yolo', sessionId, enabled });
    },

    async setAccount(accountId) {
      const next = await api.setSessionAccount(sessionId, accountId);
      // The status stays with the WebSocket: the reply can be older than the last `session` message.
      setSession((previous) => applyAccountReply(previous, next));
    },

    loop,
    loopLoaded,
    loopBusy,

    saveLoop(request) {
      return loopCall(() => api.putLoop(sessionId, request));
    },

    pauseLoop() {
      return loopCall(() => api.pauseLoop(sessionId));
    },

    resumeLoop() {
      return loopCall(() => api.resumeLoop(sessionId));
    },

    runLoopNow() {
      return loopCall(() => api.runLoopNow(sessionId));
    },

    stopLoop() {
      return loopCall(async () => {
        await api.deleteLoop(sessionId);
        return null;
      });
    },
  };
}
