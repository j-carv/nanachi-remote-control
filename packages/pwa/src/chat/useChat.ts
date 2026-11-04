import { useEffect, useState } from 'react';
import type {
  AvailableCommand,
  ClientMessage,
  ConfigValue,
  FileInfo,
  Session,
  SessionConfigOption,
  SessionEvent,
} from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Connection } from '../connection.js';
import { writeAgentConfig } from '../agentConfig.js';
import type { StorageLike } from '../machines.js';
import { applyEvents, createChatState, withStatus, type ChatState } from './reducer.js';
import { loadHistory } from './history.js';
import { createFrameBatcher } from './frameBatch.js';

export const OFFLINE_NOTICE = 'Sem conexão com o PC. Tente de novo quando voltar.';

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
  setConfig(configId: string, value: ConfigValue): boolean;
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

    loadHistory((after, limit) => api.fetchEvents(sessionId, { after, limit }), 0)
      .then((events) => {
        if (!active) return;
        const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
        setChat((previous) => applyEvents(previous, events));
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
    if (configOptions.length > 0) {
      writeAgentConfig(storage, session.agent, configOptions);
    }
  }, [storage, session.agent, configOptions]);

  function send(message: ClientMessage): boolean {
    if (connection?.send(message) === true) return true;
    setNotice(OFFLINE_NOTICE);
    return false;
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

    setConfig(configId, value) {
      return send({ type: 'set_config', sessionId, configId, value });
    },
  };
}
