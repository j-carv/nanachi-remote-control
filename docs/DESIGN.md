# Nanachi Remote: design system

Source of truth for the visual system of the PWA (`packages/pwa`). Read this before changing any screen or CSS.
UI labels stay in Portuguese; this document is in English.

## Direction

- **Mode: Operate.** A developer's tool on an iPhone. Scannable, consistent, native-feeling. No hero pages, gradients or decorative motion.
- **Monochrome.** Surfaces, text and controls are neutral greys. Primary is the foreground colour: near-black in light mode, near-white in dark mode. There is no brand accent.
- **Colour only for status.** Four muted tones: running, awaiting permission, success and error. Use them on icons and status text, sparingly. Never as large fills (the one exception is the solid destructive button in a confirmation sheet). Diff lines are one other place colour appears, as a 10% tint. Syntax highlighting in the file editor is the only other colour, and it has its own palette (see Code highlighting).
- **Light and dark follow the system** (`prefers-color-scheme`). The tokens change; the components do not. No JavaScript theme switch.
- **Phone first.** Designed for 390 × 844 (iPhone). Safe-area insets on every edge, 44 px touch targets, bottom sheets for every overlay.
- **Icons over words** where the meaning is clear (headers, section titles, row actions, settings). Text stays on destructive and primary actions, and wherever an icon alone would be ambiguous.

## Stack

- **Tailwind CSS v4** through `@tailwindcss/vite` (`packages/pwa/vite.config.ts`).
- **`@/` alias** → `packages/pwa/src`, configured in `vite.config.ts` (`resolve.alias`) and in `packages/pwa/tsconfig.json` (`paths`).
- **shadcn/ui primitives** in `packages/pwa/src/components/ui/`: `button`, `input`, `label`, `switch`, `badge`, `drawer` (vaul), `dropdown-menu` (radix-ui). They were written from the shadcn/ui sources and adapted to the `--ui-*` tokens. `packages/pwa/components.json` is kept so the shadcn CLI can add more components later.
- **Icons:** `lucide-react` only. `@phosphor-icons/react` has been removed.
- **Tokens:** `--ui-*` custom properties in `packages/pwa/src/styles.css`, mapped to Tailwind colours in `@theme inline`. They are the only UI colour tokens. The code palette (`--code-*`) is the one sanctioned exception, scoped to the editor (see Code highlighting).

## Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ui-background` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | page |
| `--ui-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | text |
| `--ui-card` | `oklch(1 0 0)` | `oklch(0.19 0 0)` | grouped list, inputs |
| `--ui-popover` | `oklch(1 0 0)` | `oklch(0.22 0 0)` | drawers, menus |
| `--ui-primary` | `oklch(0.205 0 0)` | `oklch(0.985 0 0)` | primary button, switch on |
| `--ui-primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` | text on primary |
| `--ui-secondary` | `oklch(0.955 0 0)` | `oklch(0.25 0 0)` | secondary button, status pill |
| `--ui-muted` | `oklch(0.955 0 0)` | `oklch(0.25 0 0)` | quiet fills |
| `--ui-muted-foreground` | `oklch(0.47 0 0)` | `oklch(0.72 0 0)` | secondary text, icons |
| `--ui-accent` | `oklch(0.94 0 0)` | `oklch(0.28 0 0)` | hover and pressed rows |
| `--ui-destructive` | `oklch(0.5 0.15 27)` | `oklch(0.74 0.13 25)` | destructive text and fills |
| `--ui-border` | `oklch(0.9 0 0)` | `oklch(0.3 0 0)` | hairlines, group edges |
| `--ui-input` | `oklch(0.62 0 0)` | `oklch(0.5 0 0)` | control borders (3:1) |
| `--ui-ring` | `oklch(0.55 0 0)` | `oklch(0.6 0 0)` | focus ring |
| `--ui-running` | `oklch(0.5 0.07 245)` | `oklch(0.8 0.06 245)` | status: running |
| `--ui-attention` | `oklch(0.5 0.1 70)` | `oklch(0.84 0.1 80)` | status: awaiting permission |
| `--ui-success` | `oklch(0.48 0.08 155)` | `oklch(0.8 0.09 155)` | status: success |
| `--ui-radius` | `0.75rem` | same | base radius (`rounded-sm` 8, `-md` 10, `-lg` 12, `-xl` 16) |

Contrast was checked for every text pair (≥ 4.5:1) and every control border (≥ 3:1) against the surfaces they sit on.

## Layers

`packages/pwa/src/styles.css` declares the order `theme → base → components → utilities`.

- `theme` and `utilities` come from Tailwind (`@import "tailwindcss" source(none); @source ".";`). The scan is limited to `src/`: without it Tailwind reads `dist/` and `dist-next/`.
- Preflight is part of the import and is the reset. The `base` layer sets `html` and `body` (`--ui-background`, `--ui-foreground`, the Tailwind `font-sans` stack, 17 px) and `font: inherit` on form controls.
- `components` is declared but holds no rules: components are written with utilities in the TSX.
- The stylesheet has no other rules. Write utilities; a new global rule needs a reason written in this file.

## Typography

- System stack (`font-sans`: SF Pro through `-apple-system`). Monospace (`font-mono`) only for paths, branch names, command names, code and diffs.
- Screen title: `text-xl font-semibold` (20 px) in `ScreenHeader`. The home screen uses the machine name as the title, with the status below it.
- Body in lists: 16 px (`text-base`). Inputs are 16 px as well, so iOS does not zoom on focus.
- Metadata: 14 px muted (`text-sm text-muted-foreground`).
- Section headings: 14 px medium, muted, with a 16 px icon, in sentence case (`SectionHeading`).

## Shape and spacing

- Grouped lists (`ListGroup`): `rounded-xl`, `border-border`, `bg-card`, rows separated by hairlines, `overflow-hidden` (keeps the swipe action inside the group). Never a card per row.
- Buttons and inputs: `rounded-md`. Drawers: `rounded-t-2xl`. Status pills and chips: `rounded-full`.
- Spacing on a 4 px base. Screen gap `gap-5` (20 px). Rows at least 56 px tall (`listRowClass`, `min-h-14`).
- Touch targets: 44 px minimum (`h-11` or `size-11`) for every control.
- Safe area: `Screen` pads each edge with `env(safe-area-inset-*)`. Full-height screens use `min-h-dvh` or the fixed full-height root described in Behaviour notes, never `100vh`.
- No decorative shadows. The drawer and the dropdown use a plain border and a soft shadow (`shadow-lg`) only to separate them from the page.

## Components

Shared in `packages/pwa/src/components/`:

- `Screen`: page shell (single column, 16 px gutters, safe area, `min-h-dvh`, `gap-5`). Every screen uses it except the chat and the terminal, which are full-height fixed roots (see Behaviour notes). The lazy-loading fallback uses it too.
- `ScreenHeader`: back chevron (`aria-label="Voltar"`), title, subtitle, actions. Scrolls with the content; it is not sticky.
- `ListGroup`, `listRowClass`, `listMainClass`, `SectionHeading`: the grouped-list primitives.
- `StatusDot`, `TONE_TEXT`: a status tone for dots and text.
- `SessionStatusPill`: icon in the status tone plus the state text. `data-status` carries the state for tests.
- `ErrorNotice`: inline error block (tinted destructive background, icon, text, optional repair action).
- `WorkspaceInfoBar`: branch, change count and instruction files as outline badges.
- `SwipeRow`: swipe left to reveal "Remover do app". `data-slot` hooks: `swipe-row`, `swipe-track`, `swipe-action`.
- `ActionSheet` and `ActionSheetButton`: the "…" menu and the option sheets used by the chat. A Drawer; the item API (`label`, `title`, `items`, `onClose`) is unchanged. Items carry `data-slot="action-sheet-item"`, `data-tone` and `data-mono`.
- `NewSessionSheet`, `ResumeSheet`, `RemoveSessionSheet`: Drawers. `RemoveSessionSheet` is not dismissible while busy.
- `AgentAccountsSection`: agent logins with a refresh icon button.
- `DiffLine`: one line of a diff. Added and removed lines take `bg-success/10` and `bg-destructive/10`; the text keeps full contrast. Context lines are plain, hunk headers use `bg-muted`, file metadata is muted. Each line is as wide as the longest one, so its background follows horizontal scrolling. `data-kind` is `add`, `del`, `ctx`, `hunk` or `meta`.
- `EditorScreen` (file editor, CodeMirror 6): `ScreenHeader` with the file name and path, then a `Badge` (outline) with the language name in the header's `meta` line. Toolbar: undo, redo, wrap, status, `Salvar`. Syntax highlighting is described in Code highlighting.
- `FileViewer`: full-screen dialog (portal) for an attachment. Black background with white text in both themes. Top bar with the file name and `Fechar`; actions such as `Compartilhar` and `Salvar` at the bottom.

Chat (`screens/ChatScreen.tsx`, `ConfigControls.tsx`, `UsageDrawer.tsx`):

- **Chat header:** one row. `Voltar`, then a status dot with the session title and the workspace line below it, then icon buttons: `Uso do agente` (gauge; ACP sessions only), `Alterações` (git compare), `Configurar sessão` (sliders) and `Mais ações da sessão` ("…", an ActionSheet with "Remover do app"). The bar has no text buttons.
- **Config drawer:** `Configurar sessão` is a Drawer. The three primary controls, Acesso, Modelo and Effort, are native selects in one `ListGroup`. `Mais opções` below holds the rest. The new-session sheet uses the same controls.
- **Composer:** attach (`Anexar arquivo`) and commands (`Comandos do agente`) icon buttons, then the textarea, then send. The textarea grows with its text up to `max-h-40` (160 px) and scrolls after that. Placeholders are one line and depend on the session state (for example `Mensagem`, `Aguarde o agente`, `Retomar e enviar`). The send button says "Enviar"; below 360 px it becomes a `SendHorizontal` icon and the text stays for screen readers.
- **UsageDrawer:** title "Uso do <agente>". Skeleton rows (`animate-pulse`) while loading. Footer "Atualizado <tempo relativo>". Refresh is the `Atualizar uso` icon button. Errors appear inline.
- **UpdateBar** (`updates/UpdateBar.tsx`): "Nova versão do Nanachi" with an "Atualizar" button. See Behaviour notes for when it shows and when the app reloads on its own.

Buttons (`src/components/ui/button.tsx`):

- `default`: primary, one per screen (the foreground colour).
- `secondary`, `outline`, `ghost`: everything else.
- `destructive`: solid red. Only inside a confirmation sheet.
- `destructive-ghost`: red text, for row and list actions.
- Sizes: `default` (h-11), `icon` (size-11, `aria-label` required), `wide` (full width).

Sheets: on the phone every overlay is a Drawer that rises from the bottom. Do not add a centred dialog. The exception is `FileViewer`, a full-screen dialog for media.

## Icons

Lucide icons, drawn in one stroke and size: 20 px (`size-5`) in controls and rows, 16 px in section headings, 14 px in badges. Icon-only buttons need an `aria-label` in Portuguese.

Current mapping:

| Meaning | Icon | Label |
|---|---|---|
| Back | `ChevronLeft` | Voltar |
| Add | `Plus` | Adicionar workspace, Adicionar máquina, Nova sessão (with text) |
| Settings | `Settings` | Ajustes |
| Workspaces | `FolderOpen` | Workspaces |
| Folder | `Folder` | the folder row |
| Resume from PC | `RotateCcwClock` | Retomar do PC |
| Stop session | `CircleStop` | Encerrar {session} |
| More actions | `Ellipsis` | Mais ações de {session} |
| Notifications | `Bell`, `BellOff` | Silenciar notificações, Avisos neste celular |
| Devices | `Smartphone` | Dispositivos |
| Revoke device | `ShieldOff` | Revogar (text, destructive-ghost) |
| Agent accounts | `Bot` | Contas dos agentes |
| Refresh | `RefreshCw` | Atualizar contas |
| Remove | `Trash` | Remover máquina (text), Remover {workspace} (icon) |
| Branch | `GitBranch` | branch chip |
| Instruction file | `FileText` | instruction chip |
| File, by family (explorer) | `FileCode` code, `FileBraces` JSON, `FileText` text and Markdown, `FileImage` image, `FileTerminal` shell and PowerShell and batch, `FileCog` config (TOML, YAML, INI, Dockerfile, Makefile, Gitignore), `FileLock` lockfiles, `File` other | file row (`data-icon` names the family) |

Session status icons (`SessionStatusPill`): starting and running `LoaderCircle` (spins; stops under reduced motion), idle `CircleDashed`, awaiting permission `ShieldExclamationPoint` (attention tone), stopped `CircleSlash`, error `CircleExclamationPoint` (destructive tone).

File icons are chosen by `fileIconKindFor` (`workspace/fileKinds.ts`): the name first (lockfiles, `Dockerfile`), then the image extension, then the language. The file icon is muted like the other row icons.

## Code highlighting

The file editor (`src/editor/`) is the one place where code gets colour. It is a sanctioned exception to "monochrome", with these rules:

- **The palette is `src/editor/codePalette.ts`.** Nine roles, each an OKLCH colour. `codeVariables()` turns each into a `--code-<role>: light-dark(light, dark)` custom property on the editor, and the editor sets `color-scheme: light dark`, so the pair follows the system. (`EditorView.theme` does not accept `@media`, so `light-dark()` is the way to switch.) No other component uses these roles.
- **Contrast: WCAG AA (4.5:1) for every role, both themes**, against the editor background (`--ui-card`: white in light, `oklch(0.19 0 0)` in dark). `codePalette.test.ts` checks this on every test run.

| Role | Used for | Light | Dark | Contrast light / dark |
|---|---|---|---|---|
| `keyword` | keywords, modifiers, `self` | `oklch(0.46 0.13 305)` | `oklch(0.8 0.1 305)` | 7.6 / 9.6 |
| `string` | strings, regexps, markdown code, diff additions | `oklch(0.48 0.09 150)` | `oklch(0.82 0.08 150)` | 6.3 / 10.9 |
| `number` | numbers, booleans, `null`, atoms | `oklch(0.5 0.1 60)` | `oklch(0.84 0.09 75)` | 6.2 / 11.2 |
| `comment` | comments (italic) | `oklch(0.47 0 0)` | `oklch(0.72 0 0)` | 6.8 / 7.4 |
| `type` | types, classes, namespaces, HTML and JSX tags | `oklch(0.5 0.08 200)` | `oklch(0.82 0.07 200)` | 5.8 / 10.9 |
| `function` | functions, decorators and preprocessor, headings and links (markdown) | `oklch(0.48 0.12 260)` | `oklch(0.8 0.1 260)` | 6.6 / 9.9 |
| `property` | object keys, attribute names, YAML and TOML keys | `oklch(0.5 0.1 25)` | `oklch(0.8 0.08 25)` | 6.3 / 9.6 |
| `operator` | operators | `oklch(0.4 0 0)` | `oklch(0.78 0 0)` | 9.2 / 9.2 |
| `invalid` | parse errors, deleted diff lines | `oklch(0.5 0.15 27)` | `oklch(0.74 0.13 25)` | 6.5 / 7.6 |

- **Everything else is the foreground colour.** Identifiers and punctuation are not coloured. Emphasis (`*x*`) is italic, strong (`**x**`) is bold, and links and invalid tokens are underlined.
- **Languages load on demand.** `src/editor/languages.ts` has one dynamic `import()` per language, so each parser is its own chunk. Official `@codemirror/lang-*` packages where they exist; `@codemirror/legacy-modes` through `StreamLanguage` for the rest; `src/editor/simpleLanguages.ts` for the few grammars neither has (INI, Batch, Makefile, .gitignore, GraphQL). The editor shows the plain text first and colours it when the parser arrives. If a chunk fails to load, the file opens as plain text.
- **Language by name.** `languageKeyFor` (`workspace/fileKinds.ts`) takes the file name: special names first (`Dockerfile`, `Makefile`, `.gitignore`, `.editorconfig`, `Cargo.lock`), then the extension (`*.d.ts` is TypeScript). Unknown names are plain text.
- **Badge.** The editor header shows the language name in an outline `Badge`. Plain text says `Texto`.

## Motion

- 200 ms with `cubic-bezier(0.32, 0.72, 0, 1)` for presses, switches and track movement. A pressed button scales to 0.98.
- Drawers animate through vaul.
- Infinite motion only for state: the status spinner, the connecting pulse. Each one uses Tailwind's `animate-*` with a `motion-reduce:` override, so everything stops under `prefers-reduced-motion`.

## Behaviour notes

- **Full-height root.** The chat and the terminal fill the window with `fixed inset-x-0 top-0 bottom-0`, not `h-dvh`. With the keyboard open, `useVisualViewport` returns the visible box and the screen applies it inline, which overrides the fixed box. With the keyboard closed it returns null and the fixed box applies. This is why the black strip at the bottom of an installed iPhone app is gone.
- **Composer safe area.** The composer's bottom safe-area padding is applied once, on the form. The screen root has no bottom inset.
- **Update bar and reloads** (`updates/decideUpdateAction.ts`). A waiting version shows `UpdateBar`, a single 44 px row under the status bar. It is the default. The app reloads by itself only when it comes back to the foreground and the version arrived while it was in the background. It never reloads while the composer has unsent text or a dialog is open; the bar shows instead. A visible app is never reloaded on its own.
- `useModalOverlay` (used by `ActionSheet` and the chat viewer) pushes a history entry and listens for Escape and the back gesture. Under React `StrictMode` in development, its cleanup calls `history.back()` and the sheet closes right after it opens. Production builds do not run effects twice, so the production behaviour is unaffected. When testing with a dev server, remove the `StrictMode` wrapper in `bootstrap.tsx` for the duration of the test.
- Notifications switch: the permission request is the first thing in the tap handler (iOS needs the user gesture).
- **Dark surfaces in both themes.** `FileViewer` (black background) and the terminal (xterm theme hardcoded in `terminal/options.ts`) stay dark in light mode too. Their colours are fixed, not tokens.

## Copy and language

- UI text in Portuguese, short sentences, no exclamation marks, no "Oops".
- Controls name their action. Errors name the problem and the way out.
- E2E scripts (`e2e/run-*.mjs`) select by `data-slot`, `data-status`, `aria-label`, `role` and visible text. A change to one of those updates the script in the same commit, and the assertions stay.

## Migration status

Complete. Every screen and component uses Tailwind and the shadcn primitives.

- The `legacy` CSS layer is removed, with its classes and the old tokens (`--bg`, `--surface*`, `--line`, `--text`, `--muted`, `--accent*`, `--ok*`, `--warn*`, `--danger*`, `--add-*`, `--del-*`, `--hunk-*`, `--terminal-*`, `--r-*`, `--tap`, `--font`, `--mono`, `--ease`).
- `@phosphor-icons/react` is removed. Icons are `lucide-react` only.
- Do not add new classes or tokens for the old layer. Use the `--ui-*` tokens and utilities.

## App icon and theme

- The app icon is the owner's own artwork in `packages/pwa/public/` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `icon-maskable-512.png`). Do not regenerate or replace these files from code.
- `theme-color` in `index.html` and the manifest colours in `vite.config.ts`: `#0a0a0a` (dark) and `#fafafa` (light).
