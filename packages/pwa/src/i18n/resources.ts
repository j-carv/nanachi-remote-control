// Every namespace is imported statically, so the whole dictionary ships in the main bundle and the first render never
// waits for a language file. To add a namespace, create `locales/<language>/<name>.json` for pt-BR, en and es, then add
// the three imports and the three entries below (and the name in NAMESPACES). `i18n.test.ts` fails if a file on disk
// is not registered here, or if one language lacks a file or a key.
import type { Language } from './languages.js';
import enAccounts from './locales/en/accounts.json';
import enChat from './locales/en/chat.json';
import enCommon from './locales/en/common.json';
import enDesktop from './locales/en/desktop.json';
import enDevices from './locales/en/devices.json';
import enErrors from './locales/en/errors.json';
import enFiles from './locales/en/files.json';
import enMachines from './locales/en/machines.json';
import enPairing from './locales/en/pairing.json';
import enSettings from './locales/en/settings.json';
import enTerminal from './locales/en/terminal.json';
import enUsage from './locales/en/usage.json';
import enWide from './locales/en/wide.json';
import enWorkspace from './locales/en/workspace.json';
import esAccounts from './locales/es/accounts.json';
import esChat from './locales/es/chat.json';
import esCommon from './locales/es/common.json';
import esDesktop from './locales/es/desktop.json';
import esDevices from './locales/es/devices.json';
import esErrors from './locales/es/errors.json';
import esFiles from './locales/es/files.json';
import esMachines from './locales/es/machines.json';
import esPairing from './locales/es/pairing.json';
import esSettings from './locales/es/settings.json';
import esTerminal from './locales/es/terminal.json';
import esUsage from './locales/es/usage.json';
import esWide from './locales/es/wide.json';
import esWorkspace from './locales/es/workspace.json';
import ptAccounts from './locales/pt-BR/accounts.json';
import ptChat from './locales/pt-BR/chat.json';
import ptCommon from './locales/pt-BR/common.json';
import ptDesktop from './locales/pt-BR/desktop.json';
import ptDevices from './locales/pt-BR/devices.json';
import ptErrors from './locales/pt-BR/errors.json';
import ptFiles from './locales/pt-BR/files.json';
import ptMachines from './locales/pt-BR/machines.json';
import ptPairing from './locales/pt-BR/pairing.json';
import ptSettings from './locales/pt-BR/settings.json';
import ptTerminal from './locales/pt-BR/terminal.json';
import ptUsage from './locales/pt-BR/usage.json';
import ptWide from './locales/pt-BR/wide.json';
import ptWorkspace from './locales/pt-BR/workspace.json';

export const NAMESPACES = [
  'accounts',
  'chat',
  'common',
  'desktop',
  'devices',
  'errors',
  'files',
  'machines',
  'pairing',
  'settings',
  'terminal',
  'usage',
  'wide',
  'workspace',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Namespace used when a key has no `ns:` prefix and `useTranslation` is called without one. */
export const DEFAULT_NAMESPACE = 'common' satisfies Namespace;

export const resources = {
  'pt-BR': {
    accounts: ptAccounts,
    chat: ptChat,
    common: ptCommon,
    desktop: ptDesktop,
    devices: ptDevices,
    errors: ptErrors,
    files: ptFiles,
    machines: ptMachines,
    pairing: ptPairing,
    settings: ptSettings,
    terminal: ptTerminal,
    usage: ptUsage,
    wide: ptWide,
    workspace: ptWorkspace,
  },
  en: {
    accounts: enAccounts,
    chat: enChat,
    common: enCommon,
    desktop: enDesktop,
    devices: enDevices,
    errors: enErrors,
    files: enFiles,
    machines: enMachines,
    pairing: enPairing,
    settings: enSettings,
    terminal: enTerminal,
    usage: enUsage,
    wide: enWide,
    workspace: enWorkspace,
  },
  es: {
    accounts: esAccounts,
    chat: esChat,
    common: esCommon,
    desktop: esDesktop,
    devices: esDevices,
    errors: esErrors,
    files: esFiles,
    machines: esMachines,
    pairing: esPairing,
    settings: esSettings,
    terminal: esTerminal,
    usage: esUsage,
    wide: esWide,
    workspace: esWorkspace,
  },
} satisfies Record<Language, Record<Namespace, object>>;
