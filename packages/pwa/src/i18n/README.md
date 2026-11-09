# PWA translations (i18n)

The app is translated into Brazilian Portuguese (`pt-BR`, the default), English (`en`) and Spanish (`es`) with
`i18next` and `react-i18next`. All languages are bundled: there is no lazy loading, no backend and no language detector.
The choice is stored on the device under `localStorage["nanachi.language"]`; with nothing stored the app is in `pt-BR`.

## Layout

```text
src/i18n/
  index.ts          init (synchronous), i18n, t, setLanguage, currentLanguage, SUPPORTED_LANGUAGES, readStoredLanguage
  languages.ts      the language list, the storage key, isLanguage (no i18next import)
  resources.ts      the static imports of every locales/<lng>/<namespace>.json, NAMESPACES
  types.ts          types the keys of t from the pt-BR files
  locales/pt-BR/<namespace>.json
  locales/en/<namespace>.json
  locales/es/<namespace>.json
  localeCheck.ts    the comparison used by i18n.test.ts
  vitest.setup.ts   puts every test in pt-BR (set in vite.config.ts)
  screenSweep.ts            renders every screen and panel a static render can produce, for the two sweeps below
  noPortuguese.en.test.ts   the sweep that fails when Portuguese is left in the English interface
  noPortuguese.es.test.ts   the same for Spanish, plus the check for Spanish values identical to the Portuguese ones
  screens.en.test.ts, screens.es.test.ts, helpers.es.test.ts   the wording of key screens, plurals, dates and sizes
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
  `{ id: 'free', get label() { return t('files:crop.free'); } }` (`CROP_PRESETS`).
- State that outlives a render holds the kind, not the sentence. Keep `{ kind: 'offline' }` (or a status, an error
  code, a `LoginStep`) and call `t` while rendering, as `LoginStep` and `UsageState` do. A stored sentence stays in the
  old language after a switch.
- A helper that builds display text from data (`relativeTime.ts`, `sessionText.ts`, `workspace/resumeText.ts`) calls `t`
  itself and is called from the render.

### Plurals and zero

`count` picks `_one` or `_other` with `Intl.PluralRules`. Portuguese counts 0 as singular (`0 salvo`), English and
Spanish do not (`0 saved`, `0 guardados`). When a count can be zero and the Portuguese would read wrong, add a `_zero`
form to every language (the files must have the same keys), next to `_one` and `_other`; see `resets.saved_*` and
`resets.usable_*` in `usage.json`.

Spanish also has a `_many` form, which `Intl.PluralRules('es')` returns for one million and its multiples (CLDR 42 and
later). Every plural text in `locales/es` has `_one`, `_many` and `_other`, so no count shows a bare key;
`_many` is the `_other` text with the "de" Spanish puts before a noun (`{{count}} de líneas`, `1000000 de líneas`),
and the same text as `_other` for an adjective (`{{count}} guardados`). `i18n.test.ts` fails when an `es` plural text lacks
a form that its rules use, and does not count `_many` as an extra key. Portuguese has `many` too but no file writes it,
so a count of one million or more in `pt-BR` shows the bare key; nothing in the app counts that high.

## Adding a key

1. Add it to `locales/pt-BR/<namespace>.json`, then to `locales/en/<namespace>.json` and `locales/es/<namespace>.json`
   with the same name and the same `{{placeholders}}` (a plural text also gets `_many` in `es`).
2. Use it. `npm test -w @nanachi/pwa` runs `i18n.test.ts`, which fails when the languages differ in files, keys,
   placeholders or empty texts, or when a `_one` form has no `_other`. `noPortuguese.es.test.ts` fails when the Spanish
   text is identical to the Portuguese one; if the two languages really spell it the same, list the key there.

## Adding a namespace

Create `locales/pt-BR/<name>.json`, `locales/en/<name>.json` and `locales/es/<name>.json`, then add the three imports,
the three entries and the name in `NAMESPACES` in `resources.ts`. The test fails if a file on disk is not registered
there.

## Namespaces and who owns them

| Namespace | Area |
|---|---|
| `common` | Shared words, the app shell (`App`, `bootstrap`), `ScreenHeader`, `ErrorNotice`, `ShowAll`, `NameSheet`, `ActionSheet`, session status and title helpers, relative time, update bar, force update |
| `machines` | Home screen, machine cards, summary line |
| `pairing` | Pairing screen |
| `devices` | Devices of a machine |
| `settings` | Settings screen, language row |
| `errors` | Every text built from an API error (`errorMessages.ts`) |
| `wide` | The wide layout (`src/wide`): the list pane, the empty screen, the third pane, the Enter hint |
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
- Spanish copy: neutral Latin American Spanish, addressing the reader as "tú" (no voseo, no usted, no regional slang),
  with the same rules as the English copy: short, sentence case, product terms kept (Nanachi, Tailscale, worktree, Loop,
  workspace), opening `¿` for a question. "Teléfono" for the phone, "vincular" for pairing, "quitar" to remove something
  from the app and "eliminar" to delete it, "reanudar" for resuming a session.
- Tests run in pt-BR, so assertions on Portuguese text keep passing. Call `setLanguage('en')` or `setLanguage('es')` in a
  test to check the text of that language; `vitest.setup.ts` resets it after each test.
- `noPortuguese.en.test.ts` renders the screens and panels that `renderToStaticMarkup` can render, in English, with fake
  data written in English, and fails on any Portuguese UI word or accented letter in their text, `aria-label`, `title`,
  `placeholder` and `alt`. It also scans every value of `locales/en/*.json`, which covers the sheets (a static render does
  not mount a drawer; `e2e/run-i18n.mjs` opens them in a browser). What is rendered lives in `screenSweep.ts`, which
  `noPortuguese.es.test.ts` uses too: when you add a screen or a panel, add it there, once. Keep the fake data in
  English, or the data will trip the word list. A text that is Portuguese on purpose in the English interface goes in
  `KEPT_PORTUGUESE`.
- `noPortuguese.es.test.ts` does the same for Spanish. Spanish and Portuguese share many words, so its word list holds
  only Portuguese words that are not Spanish ones, plus the letters Spanish never uses (`ã õ ç â ê ô à`). It also fails
  on any `es` value that is identical to its `pt-BR` value, because an untranslated copy looks exactly like that. A text
  that both languages really spell the same (a product term, a keycap, `Cancelar`) goes in `PRODUCT_OR_TECHNICAL` or
  `SAME_WORD_IN_BOTH` in that file; the test also fails when a listed text is no longer identical, so the list cannot
  go stale.
- Do not import `i18n/index.ts` (or anything that does, such as `errorMessages.ts` or `forceUpdate.ts`) from
  `sw.ts`: it would bundle i18next and every translation into the service worker.
- Push notification texts are built by the daemon (`push-text.ts`) in the language the phone sent with its push
  subscription (`language`, sent on subscribe and again when the language changes); a phone that sent none gets pt-BR.
  The fallback in `push/payload.ts` stays Portuguese, because the service worker cannot read the app language. The
  Desktop tray, windows and installer are not translated either, and neither is the manifest `description`, which is a
  static file.
- Some Portuguese is data and stays: the notes the daemon appends to a prompt (`chat/promptNotes.ts`), the loop
  markers (`chat/loopMarkers.ts`), the placeholder session title `Nova sessão` (`sessionText.ts`) and the language names
  in the Settings row (`Português (Brasil)`, `English`, `Español`, each in its own language, under the title
  `Idioma / Language`, which reads naturally in all three).
- Dates and times go through `Intl` with the current language and a format per language in `relativeTime.ts`,
  `usage/resetsModel.ts` and `workspace/resumeText.ts`: `28/10/2026` in Portuguese and Spanish, `Oct 28, 2026` in
  English. Spanish uses the plain `es` locale, so a decimal is written with a comma (`1,5 MB`), as in Portuguese.
