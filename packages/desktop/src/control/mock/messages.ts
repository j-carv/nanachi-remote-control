/**
 * The error texts the in-memory `ControlApi` answers with. Like main, the mock words them in Desktop's current language
 * (`api.language`, which `settings.setLanguage` changes), so a screenshot or a test in English or Spanish never shows
 * Portuguese. They live here and not in the shipped dictionaries: the mock is not part of a shipped bundle.
 */
import type { Language } from '../../common/i18n/index.js';

export interface MockMessages {
  /** Attached to a daemon Desktop did not start: it does not know this app. */
  notPaired: string;
  /** The daemon does not answer on its port (`port` is the one in the message). */
  unreachable: (port: number) => string;
  unreachableShort: (port: number) => string;
  portBusy: (port: number) => string;
  notOwnDaemon: string;
  rootsReadOnly: string;
  notAFullPath: (raw: string) => string;
  deviceGone: string;
  deviceSelf: string;
  accountsRefused: string;
}

export const MOCK_MESSAGES: Record<Language, MockMessages> = {
  'pt-BR': {
    notPaired: 'Este app ainda não está pareado com o daemon que já estava rodando, então ele não pode ler isto.',
    unreachable: (port) => `O daemon não respondeu em 127.0.0.1:${port}. Tente de novo em alguns segundos.`,
    unreachableShort: (port) => `O daemon não respondeu em 127.0.0.1:${port}.`,
    portBusy: (port) => `A porta ${port} está ocupada por outro programa.`,
    notOwnDaemon: 'O Nanachi só reinicia o daemon que ele mesmo iniciou.',
    rootsReadOnly: 'A lista só pode ser mudada no daemon que o Nanachi iniciou.',
    notAFullPath: (raw) => `“${raw}” não é um caminho completo, como C:\\Projetos.`,
    deviceGone: 'Esse aparelho não existe mais.',
    deviceSelf: 'Este app não pode revogar o próprio acesso.',
    accountsRefused: 'O daemon que já estava rodando não aceitou o acesso deste app.',
  },
  en: {
    notPaired: 'This app is not paired yet with the daemon that was already running, so it cannot read this.',
    unreachable: (port) => `The daemon did not answer on 127.0.0.1:${port}. Try again in a few seconds.`,
    unreachableShort: (port) => `The daemon did not answer on 127.0.0.1:${port}.`,
    portBusy: (port) => `Port ${port} is in use by another program.`,
    notOwnDaemon: 'Nanachi only restarts the daemon it started itself.',
    rootsReadOnly: 'The list can only be changed on the daemon that Nanachi started.',
    notAFullPath: (raw) => `“${raw}” is not a full path, like C:\\Projects.`,
    deviceGone: 'That device no longer exists.',
    deviceSelf: 'This app cannot revoke its own access.',
    accountsRefused: 'The daemon that was already running did not accept this app’s access.',
  },
  es: {
    notPaired: 'Esta app aún no está emparejada con el daemon que ya estaba en ejecución, así que no puede leer esto.',
    unreachable: (port) => `El daemon no respondió en 127.0.0.1:${port}. Intenta de nuevo en unos segundos.`,
    unreachableShort: (port) => `El daemon no respondió en 127.0.0.1:${port}.`,
    portBusy: (port) => `El puerto ${port} está ocupado por otro programa.`,
    notOwnDaemon: 'Nanachi solo reinicia el daemon que él mismo inició.',
    rootsReadOnly: 'La lista solo se puede cambiar en el daemon que Nanachi inició.',
    notAFullPath: (raw) => `“${raw}” no es una ruta completa, como C:\\Proyectos.`,
    deviceGone: 'Ese dispositivo ya no existe.',
    deviceSelf: 'Esta app no puede revocar su propio acceso.',
    accountsRefused: 'El daemon que ya estaba en ejecución no aceptó el acceso de esta app.',
  },
};
