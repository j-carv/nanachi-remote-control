# PWA translations (i18n)

The app is translated into Brazilian Portuguese (`pt-BR`, the default) and English (`en`) with `i18next` and
`react-i18next`. Both languages are bundled: there is no lazy loading, no backend and no language detector. The choice
is stored on the device under `localStorage["nanachi.language"]`; with nothing stored the app is in `pt-BR`.

## Layout

```text
src/i18n/
  index.ts          init (synchronous), i18n, t, setLanguage, currentLanguage, SUPPORTED_LANGUAGES, readStoredLanguage
  languages.ts      the language list, the storage key, isLanguage (no i18next import)
  resources.ts      the static imports of every locales/<lng>/<namespace>.json, NAMESPACES
  types.ts          types the keys of t from the pt-BR files
  locales/pt-BR/<namespace>.json
  locales/en/<namespace>.json
  localeCheck.ts    the comparison used by i18n.test.ts
  vitest.setup.ts   puts every test in pt-BR (set in vite.config.ts)
  noPortuguese.en.test.ts   the sweep that fails when Portuguese is left in the English interface
```

`App.tsx` subscribes to the language and keys the active screen on it: switching the language remounts the screen, so
helpers that call `t` while rendering pick it up. Navigation state is kept.

## Using it

Inside a component, use the hook with the namespace of the area:

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation('machines');
t('card.noSessions');                       // unprefixed key, from machines.json
t('actions.back', { ns: 'common' });        // a word from another namespace
t('card.workspaces', { count: 3 });         // plural: card.workspaces_one / card.workspaces_other
t('card.lastActivity', { time });           // interpolation: "Última atividade {{time}}"
```

Outside React (helpers, reducers, error texts, anything that builds display text), use the exported `t` and prefix the
namespace:

```ts
import { t } from './i18n/index.js';

t('errors:api.network');
t(`common:sessionStatus.${status}`);        // fine when `status` is a union of the existing keys
```

Keys are typed from the pt-BR files, so a typo or a missing key fails `npm run typecheck`. For a key built from a
value that is not a union (an error code from the daemon), list the known codes as a `const` array, narrow with it, and
fall back to a generic text (see `knownCode` in `errorMessages.ts`).

### Text that has to follow a language change

`t` returns the text of the language at the moment it is called, and the screen only remounts when the language
changes. So never call `t` where it runs once, at module load, and keep the result for good:

```ts
export const OFFLINE_NOTICE = t('chat:offline');          // wrong: frozen in the language the app started in
export function offlineNotice(): string { return t('chat:offline'); }   // right: read when it is needed
```

- A fixed label inside a constant (a preset, a keycap) is a getter, so every read translates again:
  `{ id: 'free', get label() { return t('files:crop.free'); } }` (`CROP_PRESETS`, `TERMINAL_KEYS`).
- State that outlives a render holds the kind, not the sentence. Keep `{ kind: 'offline' }` (or a status, an error
  code, a `LoginStep`) and call `t` while rendering, as `LoginStep` and `UsageState` do. A stored sentence stays in the
  old language after a switch.
- A helper that builds display text from data (`relativeTime.ts`, `sessionText.ts`, `workspace/resumeText.ts`) calls `t`
  itself and is called from the render.

### Plurals and zero

`count` picks `_one` or `_other` with `Intl.PluralRules`. Portuguese counts 0 as singular (`0 salvo`), English does not
(`0 saved`). When a count can be zero and the Portuguese would read wrong, add a `_zero` form to both languages (the two
files must have the same keys), next to `_one` and `_other`; see `resets.saved_*` and `resets.usable_*` in `usage.json`.

## Adding a key

1. Add it to `locales/pt-BR/<namespace>.json`, then to `locales/en/<namespace>.json` with the same name and the same
   `{{placeholders}}`.
2. Use it. `npm test -w @nanachi/pwa` runs `i18n.test.ts`, which fails when the two languages differ in files, keys,
   placeholders or empty texts, or when a `_one` form has no `_other`.

## Adding a namespace

Create `locales/pt-BR/<name>.json` and `locales/en/<name>.json`, then add the two imports, the two entries and the name
in `NAMESPACES` in `resources.ts`. The test fails if a file on disk is not registered there.

## Namespaces and who owns them

| Namespace | Area |
|---|---|
| `common` | Shared words, the app shell (`App`, `bootstrap`), `ScreenHeader`, `ErrorNotice`, `ShowAll`, `NameSheet`, `ActionSheet`, session status and title helpers, relative time, update bar, force update |
| `machines` | Home screen, machine cards, summary line |
| `pairing` | Pairing screen |
| `devices` | Devices of a machine |
| `settings` | Settings screen, language row |
| `errors` | Every text built from an API error (`errorMessages.ts`) |
| `chat`, `usage`, `accounts`, `workspace`, `files`, `terminal`, `desktop` | One area task each |

A task owns its namespace files and the source files of its area. A word that two areas share goes in each area's own
namespace, or in `common` when the infrastructure task adds it.

## Rules

- Translate everything the user reads: texts, `aria-label`, `title`, `placeholder`, empty states, confirmations.
- Do not translate data: agent output, file contents, command names (`/model`), session titles, text that the daemon
  or an agent sends (their error messages, login output, reset lines). The one exception is the placeholder title
  `Nova sessão` the daemon gives a new session; `displaySessionTitle` in `sessionText.ts` translates it.
- Plurals use `_one` and `_other` with `count`. Dates and numbers go through `Intl` with `currentLanguage()` (see
  `relativeTime.ts`); never build a date by hand.
- Do not store a translated text in state that outlives a language change; store the kind and translate at render
  (see "Text that has to follow a language change").
- Messages for developers stay English and are not translated: `throw new Error(...)`, `console.warn`, schema
  refinements, `ApiError.message`. The user never reads them; the screens map the error to a text in `errors.json`.
- English copy: natural, short, sentence case, same tone as the Portuguese. Product terms stay (Nanachi, Tailscale,
  worktree, Loop). No emoji.
- Tests run in pt-BR, so assertions on Portuguese text keep passing. Call `setLanguage('en')` in a test to check the
  English text; `vitest.setup.ts` resets it after each test.
- `noPortuguese.en.test.ts` renders the screens and panels that `renderToStaticMarkup` can render, in English, with fake
  data written in English, and fails on any Portuguese UI word or accented letter in their text, `aria-label`, `title`,
  `placeholder` and `alt`. It also scans every value of `locales/en/*.json`, which covers the sheets (a static render does
  not mount a drawer; `e2e/run-i18n.mjs` opens them in a browser). When you add a screen or a panel, add it there. Keep the
  fake data in English, or the data will trip the word list. A text that is Portuguese on purpose in the English
  interface goes in `KEPT_PORTUGUESE`.
- Do not import `i18n/index.ts` (or anything that does, such as `errorMessages.ts` or `forceUpdate.ts`) from
  `sw.ts`: it would bundle i18next and every translation into the service worker.
- Push notification texts are built by the daemon and stay in Portuguese, and so does the fallback in
  `push/payload.ts` (the service worker cannot read the app language). The Desktop tray, windows and installer are not
  translated either, and neither is the manifest `description`, which is a static file.
- Some Portuguese is data and stays: the notes the daemon appends to a prompt (`chat/promptNotes.ts`), the loop
  markers (`chat/loopMarkers.ts`), the placeholder session title `Nova sessão` (`sessionText.ts`) and the language names
  in the Settings row.
