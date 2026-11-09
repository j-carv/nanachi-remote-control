import type { AppLanguage } from '@nanachi/shared';

/**
 * Web Push notification texts, per device language. The ones that take data are functions: word order changes from one
 * language to another, and there are no plurals here, so no text is built by concatenating a plural.
 */
export interface PushText {
  /** Title of the loop-paused notice (in place of the workspace name). */
  loopPausedTitle: string;
  /** Title of the device-paired notice: the app name. */
  pairedTitle: string;
  /** A turn finished in the session. */
  turnEnd(sessionTitle: string): string;
  /** A terminal (PTY session) closed. */
  terminalExit: string;
  /** A permission request with the tool title. */
  permissionRequest(title: string): string;
  /** A permission request without a title. */
  permissionRequestUntitled: string;
  /** A substantive user decision, separate from an agent's execution permissions. */
  userQuestion(question: string): string;
  /** An explicit phone file selection, independent of execution permissions. */
  fileRequest(prompt: string): string;
  /** A preview card waiting for the user to open it. */
  preview(title: string): string;
  /** An error in the session. */
  error(message: string): string;
  /** A file received or sent in the session. */
  file(name: string): string;
  /** Loop paused: the session title and the failure message. */
  loopPaused(sessionTitle: string, message: string): string;
  /** A new device paired through Tailscale. */
  devicePaired(deviceName: string): string;
}

/** Texts per language. pt-BR is the default and the text the daemon always sent. */
export const PUSH_TEXT: Record<AppLanguage, PushText> = {
  'pt-BR': {
    loopPausedTitle: 'Loop pausado',
    pairedTitle: 'Nanachi Remote',
    turnEnd: (sessionTitle) => `Terminou: ${sessionTitle}`,
    terminalExit: 'Terminal encerrado',
    permissionRequest: (title) => `Pede aprovação: ${title}`,
    permissionRequestUntitled: 'Pede aprovação',
    userQuestion: (question) => `Precisa da sua resposta: ${question}`,
    fileRequest: (prompt) => `Precisa de um arquivo: ${prompt}`,
    preview: (title) => `Pré-visualização disponível: ${title}`,
    error: (message) => `Erro: ${message}`,
    file: (name) => `Arquivo: ${name}`,
    loopPaused: (sessionTitle, message) => `${sessionTitle}: ${message}`,
    devicePaired: (deviceName) => `Novo aparelho entrou com Tailscale: ${deviceName}`,
  },
  en: {
    loopPausedTitle: 'Loop paused',
    pairedTitle: 'Nanachi Remote',
    turnEnd: (sessionTitle) => `Finished: ${sessionTitle}`,
    terminalExit: 'Terminal closed',
    permissionRequest: (title) => `Needs approval: ${title}`,
    permissionRequestUntitled: 'Needs approval',
    userQuestion: (question) => `Needs your answer: ${question}`,
    fileRequest: (prompt) => `Needs a file: ${prompt}`,
    preview: (title) => `Preview available: ${title}`,
    error: (message) => `Error: ${message}`,
    file: (name) => `File: ${name}`,
    loopPaused: (sessionTitle, message) => `${sessionTitle}: ${message}`,
    devicePaired: (deviceName) => `New device joined with Tailscale: ${deviceName}`,
  },
  es: {
    loopPausedTitle: 'Loop pausado',
    pairedTitle: 'Nanachi Remote',
    turnEnd: (sessionTitle) => `Terminó: ${sessionTitle}`,
    terminalExit: 'Terminal cerrada',
    permissionRequest: (title) => `Necesita aprobación: ${title}`,
    permissionRequestUntitled: 'Necesita aprobación',
    userQuestion: (question) => `Necesita tu respuesta: ${question}`,
    fileRequest: (prompt) => `Necesita un archivo: ${prompt}`,
    preview: (title) => `Vista previa disponible: ${title}`,
    error: (message) => `Error: ${message}`,
    file: (name) => `Archivo: ${name}`,
    loopPaused: (sessionTitle, message) => `${sessionTitle}: ${message}`,
    devicePaired: (deviceName) => `Nuevo dispositivo se unió con Tailscale: ${deviceName}`,
  },
};

/** The texts for the requested language. No language (older subscription, or a client that did not send one) gives pt-BR. */
export function pushTextOf(language: AppLanguage | null | undefined): PushText {
  return PUSH_TEXT[language ?? 'pt-BR'];
}
