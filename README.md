<div align="center">
  <img src="packages/pwa/public/icon-512.png" alt="Nanachi Remote logo" width="160" />

  <h1>Nanachi Remote</h1>

  <p><strong>Your agents keep building. You keep moving.</strong></p>
  <p>Pick up your coding sessions from your phone. Review changes, talk to your agents, and approve the next step—away from your desk.</p>

  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22 or later" /></a>
    <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/PC-Windows-0078D4?style=flat-square" alt="Windows daemon" /></a>
    <a href="#install-on-your-phone"><img src="https://img.shields.io/badge/PWA-Android%20%2B%20iPhone-8B5CF6?style=flat-square&logo=pwa&logoColor=white" alt="Web app for Android and iPhone" /></a>
    <a href="https://www.tailscale.com/"><img src="https://img.shields.io/badge/Network-Tailscale-242424?style=flat-square&logo=tailscale&logoColor=white" alt="Connection through Tailscale" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.9" /></a>
  </p>

  <p><sub><em>Disclaimer: Nanachi is a character from <strong>Made in Abyss</strong>, created by Akihito Tsukushi and published by Takeshobo; the anime adaptation is produced by Kinema Citrus. All rights to the character and the series belong to their respective owners. This is an unofficial fan-named Open-Source Project with no affiliation with, or endorsement by, the author, the publisher, or the studio.</em></sub></p>

  <p><a href="#get-started-on-your-pc">Setup</a> · <a href="#install-on-your-phone">Android and iPhone</a> · <a href="#everyday-use">How to use it</a> · <a href="#nanachi-desktop">Desktop</a> · <a href="#troubleshooting">Help</a></p>
</div>

---

## Why Nanachi?

Nanachi, from *Made in Abyss*, is a guide who is always on the move, keeps watch over the people in her care from wherever she is, and lives quietly in a hideout in the depths. Nanachi Remote borrows those traits:

- **Always on the move, always watching.** Nanachi keeps watch from anywhere; the app lets you watch your agents from your phone.
- **Sees what others cannot.** Nanachi can sense the Abyss's force field, which others cannot see; the app shows what your agents are doing on your PC.
- **A caretaker for explorers.** Nanachi is a resourceful guide who looks after the explorers she travels with; the app looks after your sessions and tells you when you are needed.
- **Quiet and hidden.** Nanachi makes a home in a hideout far from the surface; the daemon runs quietly on your PC.

---

## The idea

Leave an agent working on Windows and continue the conversation from your phone. Nanachi is the bridge: it organizes projects and sessions, displays chat and terminal output, accepts attachments, and lets you know when you are needed.

Your own PC serves the dashboard inside your Tailscale network. **There is no need to host a cloud backend, forward router ports, or use WSL.** Agents still use their own AI services and accounts—Nanachi does not replace those accounts or make the models run locally.

> Your PC must be powered on, connected to Tailscale, and running the daemon. Your phone is the remote control, not where the agent runs.

### What you can do

- **Chat with agents** with real-time responses, Markdown, code, and tool details.
- **Choose model, access, and effort settings** when the agent supports them, and respond to permission requests in chat. Long model lists are [grouped by provider](#model-picker-with-many-providers).
- **Use `/` commands** advertised by the agent, with search built into the message field.
- **Resume PC sessions** when the agent supports listing and reopening its history.
- **Keep several logins per agent** for Claude Code and Codex, and [switch between them](#agent-accounts) per session.
- **Spend saved rate-limit resets** for Oh My Pi and Codex from the [usage drawer](#saved-rate-limit-resets).
- **Use the app in Portuguese, English or Spanish** ([language](#language)).
- **Send photos and files** and receive files or PC screenshots in chat.
- **View Git changes** and open sessions in separate worktrees without changing the main checkout.
- **Switch between PCs**, mute projects, and revoke paired devices.
- **Receive notifications**, even when the app is not focused, if the operating system and browser allow it.

### Agents

| Agent | How it appears in the app | What to prepare on your PC |
| --- | --- | --- |
| Oh My Pi (`omp`) | Chat through ACP | Install `omp`, add it to PATH, and configure your account. |
| Claude Code | Chat through ACP | Sign in locally; the `claude-agent-acp` adapter is included with the daemon. |
| Codex | Chat through ACP | Sign in locally; the `codex-acp` adapter is included with the daemon. |
| Antigravity (`agy`) | Interactive terminal | Install `agy`, sign in, and accept the trust prompts for the folders you will use. |

ACP is the protocol used to communicate with agents. Antigravity uses a real terminal, so some chat and resume features do not apply to it.

## Before you install

On your **PC**:

- Windows—the project's development environment is Windows 11.
- [Node.js](https://nodejs.org/) **22 or later**, with npm.
- [Git](https://git-scm.com/) on PATH, to clone the project, view changes, and use worktrees.
- [Tailscale](https://tailscale.com/download), installed and connected.
- At least one agent you want to use, with its account configured in the terminal.

On your **phone**:

- Tailscale installed, with access to the same tailnet as your PC.
- **Android:** an up-to-date Chrome browser is the recommended way to install the web app.
- **iPhone:** Safari. Notifications require **iOS 16.4 or later** and the app installed on the Home Screen.

In the [Tailscale admin console](https://login.tailscale.com/admin/dns), enable **HTTPS Certificates** under DNS. This lets you open the dashboard over HTTPS and install the PWA correctly.

## Get started on your PC

Run the following commands from the project root in PowerShell or your preferred Windows terminal.

### 1. Download and build

```powershell
git clone https://github.com/j-carv/nanachi-remote-control.git
cd nanachi-remote-control
npm install
npm run build
```

### 2. Create the configuration

```powershell
npm run start -w @nanachi/daemon
```

On its first run, the daemon creates `%USERPROFILE%\.nanachi-remote` and its `config.json` file. Stop it with **Ctrl+C**, open the file, and set your authorized folders and login:

```json
{
  "port": 7777,
  "host": "127.0.0.1",
  "machineName": "My PC",
  "allowedRoots": ["C:\\Projects", "D:\\Dev"],
  "allowedTailscaleLogins": ["you@example.com"],
  "corsOrigins": []
}
```

Use folders that exist on your machine. The login is your Tailscale account login; check it with `tailscale status`. Keep any other fields already present in the file.

- `allowedRoots` defines which folders are available when creating workspaces. **It is not an agent sandbox.**
- `allowedTailscaleLogins` defines who can connect through your tailnet. Do not leave it empty: an empty list accepts any login forwarded by Tailscale Serve.
- Keep `host` on loopback. Do not change it to `0.0.0.0`—the daemon refuses to listen directly on the network.

Start the daemon again and leave the terminal open:

```powershell
npm run start -w @nanachi/daemon
```

### 3. Make it available on your tailnet

In **another terminal**:

```powershell
tailscale serve --bg http://localhost:7777
tailscale serve status
```

Save the HTTPS address shown, such as `https://my-pc.my-tailnet.ts.net`. This is the address you will open on your phone. If your Tailscale version has different options, see the [Serve reference](https://tailscale.com/kb/1242/tailscale-serve).

> **Use `tailscale serve`, never `tailscale funnel`.** Serve keeps access within your tailnet; Funnel publishes the service on the internet. Do not forward port 7777 on your router.

### 4. Generate a pairing code

With the daemon running:

```powershell
npm run pair -w @nanachi/daemon
```

This displays a **6-digit code**, valid for **5 minutes** and usable only once. Now switch to your phone.

## Install on your phone

The app opens in Brazilian Portuguese, and English and Spanish interfaces are available under [Language](#language). This README gives the Portuguese labels with their English meanings, so you can find them in any language.

### Android

1. Open **Tailscale** on Android, sign in, and make sure it is connected to the same tailnet as your PC.
2. In **Chrome**, open the PC's HTTPS address shown by `tailscale serve status`.
3. Open Chrome's **⋮** menu → **Install and create shortcut → Install**. Depending on your version, this may appear as **Add to Home screen → Install** or simply **Install app**. Browser menu labels depend on your browser language.
4. Confirm, then open **Nanachi Remote from its icon** in your launcher or home screen. It should open in its own window, without an address bar.
5. Tap **Pair machine (Parear máquina)**, check the PC address, enter the 6-digit code, and name your device.
6. In Nanachi's **Settings (Ajustes)**, enable notifications and accept the Chrome/Android permission request if prompted.

This is not an APK and does not require the Play Store. Installation happens through the browser; see the [Chrome guide to web apps on Android](https://support.google.com/chrome/answer/9658361?hl=en&co=GENIE.Platform%3DAndroid).

**Only seeing “Create shortcut”?** Make sure you are using an up-to-date Chrome browser at the **HTTPS** address, not an incognito tab or another app's embedded browser. Open the page directly in Chrome. Menu names may vary by version and manufacturer.

Keep Tailscale connected to receive notifications. If they do not arrive, check the app/Chrome notification permissions in Android settings. Manufacturer battery restrictions can also delay the connection or notifications.

### iPhone

1. Open **Tailscale**, connect to the same tailnet, and leave it active.
2. In **Safari**, open the PC's HTTPS address.
3. Tap **Share → Add to Home Screen** and confirm. Browser menu labels depend on your system language.
4. Open Nanachi **from its Home Screen icon**, not from the Safari tab.
5. Tap **Pair machine (Parear máquina)**, check the address, enter the code, and name your device.
6. In **Settings (Ajustes)**, enable notifications and accept the iOS permission request.

On iPhone, web notifications require **iOS 16.4+** and the app installed on the Home Screen. Leaving the page open in Safari is not enough.

**Code expired?** Generate another on your PC with the same command. Each device needs its own pairing.

## Everyday use

### Open a project and start chatting

1. Select your PC on the machines screen.
2. Tap **+ Workspace**, browse to an authorized folder, and choose **Use this folder (Usar esta pasta)**.
3. Inside the workspace, tap **New session (Nova sessão)**, choose an agent, and adjust the options it provides.
4. Tap **Create session (Criar sessão)** and send your message.

Model, access, and effort selectors depend on the agent, and the app remembers your last choice for each one. Permission requests appear as cards in chat. **Stop (Parar)** interrupts the current work.

Type `/` at the beginning of a message or use the commands button to see what the agent has advertised. If it does not advertise commands, there is no universal list to display.

### Pick up where you left off

- **Resume (Retomar):** reopens a stopped or failed session when the agent supports resuming.
- **Resume from PC (Retomar do PC):** lists the agent's sessions for that workspace and lets you bring them into the app when listing is supported.
- **End (Encerrar):** stops the process but keeps the session in the list.
- **Remove from app (Remover do app):** deletes the session's record, events, and files from Nanachi. If it is working, it will be interrupted. This **does not delete the agent's own history**.

Antigravity terminal sessions cannot be resumed. If an agent does not support resuming, create a new session.

### Photos, files, and screenshots

Use the paperclip in chat to attach photos or files. Images are sent as images when the agent accepts that input type; otherwise, it receives the file path.

To send from PC → phone, an agent running inside a Nanachi session can use:

```powershell
phone-send "C:\Projects\my-app\result.png" --caption "Here is the result"
phone-send --screenshot
```

The file appears in chat and may trigger a notification. This command works **only inside a Nanachi session**; it is not a global utility for any terminal.

By default, the app tells the agent about `phone-send` in the first prompt of a new ACP session. Imported or resumed sessions do not receive this hint; in those cases, explain the command to the agent or include it in its global instructions. Set `phoneSendHint: false` in `config.json` to disable the automatic hint.

### Git and terminal

In a Git workspace, **Changes (Alterações)** shows modified files, including untracked files, and each file's patch. To isolate a task, select **In a separate worktree (Em worktree separado)** when creating the session: it gets its own checkout and branch.

When ending a session, the app can remove the worktree. If it contains uncommitted changes, removal is refused to preserve your work; the branch is deleted only if it has already been merged.

Antigravity sessions open a terminal with keys such as Esc, Tab, Ctrl+C, arrows, and Enter. Complete the first login and accept folder trust in your PC's terminal before using it from your phone.

### Agent accounts

Claude Code and Codex can have several logins on the same PC, for example a personal and a work account, and you can choose which one a session uses. Oh My Pi and Antigravity are not supported (see the limits below).

- The login already on your PC is the **principal** account. Nanachi never creates, moves, or deletes it.
- Every other account has its own folder under `accounts\<agent>\` in your data folder (`%USERPROFILE%\.nanachi-remote` by default) and keeps its own credentials there.
- Accounts share the principal's configuration, so every account behaves the same (see below).

**Add an account**

1. Open **Settings → Agent accounts (Ajustes → Contas dos agentes)**, find the agent, and tap **Add account (Adicionar conta)**.
2. Name the account. The login sheet opens.
3. Tap **Open link (Abrir link)** and sign in with the account you want to add.
   - **Codex** shows a one-time code to type on the login page.
   - **Claude Code** shows a code on the page after you sign in. Copy it, paste it into the sheet, and tap **Send (Enviar)**.
4. The sheet confirms with "Conta conectada: ..." (account connected) and closes. **Cancel (Cancelar)** stops the login, and a login that does not finish within 15 minutes fails.

Only one login per agent can run at a time.

**Choose the account**

- Tap an account to open its actions: **Use for new sessions (Usar em novas sessões)**, **Sign in (Entrar)** again, **Rename (Renomear)**, and **Remove (Remover)**. The account that new sessions use has an **In use (Em uso)** badge. The principal account cannot be renamed or removed.
- When an agent has more than one account, the new-session sheet has an **Account (Conta)** row. The default is the account in use.
- In an open session, **Configure session (Configurar sessão) → Account (Conta)** switches the account. It is disabled while the agent is working or waiting for permission ("Troque quando o agente terminar", switch when the agent finishes). A switch restarts the agent's process and resumes the session under the new account; the chat shows "Conta trocada para ..." (account changed to).
- Removing an account deletes its login from this PC and returns its sessions to the principal account. It does not affect the account itself, and it is refused while a session on that account is running. Each agent can have up to 10 extra accounts.

The usage drawer shows which account the session uses.

**What is shared and what is private**

Shared with the principal: settings, instruction files (`CLAUDE.md`, `AGENTS.md`), skills, commands, hooks, plugins, MCP servers, and session history. Private to each account: credentials, account identity, and per-account state and caches. Nanachi links or copies the shared items from the principal's home before every agent start.

<details>
<summary><strong>Exact shared items</strong></summary>

Folders are shared with directory junctions (no administrator rights needed) and files are copied from the principal on every start.

- **Claude Code:** `settings.json`, `keybindings.json`, every top-level `*.md` file, and the `projects`, `skills`, `agents`, `commands`, `hooks`, `plugins`, `plans`, `file-history`, `todos`, `tasks`, and `output-styles` folders. From `.claude.json`: `mcpServers`, `projects`, `theme`, `hasCompletedOnboarding`, and `lastOnboardingVersion`. Everything else in `.claude.json` stays per account.
- **Codex:** `config.toml`, `AGENTS.md`, `AGENTS.override.md`, `hooks.json`, `cap_sid`, and the `sessions`, `archived_sessions`, `skills`, `prompts`, `rules`, and `memories` folders. The Windows sandbox folders (`.sandbox`, `.sandbox-bin`, `.sandbox-secrets`) are linked only if the principal already has them. Credentials, thread names, and Codex's state database are per account; threads still list from the shared session files.

</details>

**Limits**

- Settings changed while you use an extra account are overwritten from the principal the next time the agent starts. This covers Claude's `/config` and trusting a project in Codex. Change settings on the principal account.
- Claude's login also opens a browser tab on the PC. The login sheet says you can ignore it.
- Oh My Pi keeps several accounts by itself (its own `/login`). Antigravity keeps its login in the Windows Credential Manager, so a second home cannot hold a second login. Neither has account support here.
- Automated tests use fake login commands. A login with a real second Claude Code or Codex account has not been tried yet, and neither has Codex with `[windows] sandbox = "elevated"` on an extra account.

### Saved rate-limit resets

Some providers give your account saved rate-limit resets. A reset lifts a usage limit immediately. For **Oh My Pi** and **Codex** sessions, Nanachi lists them and can spend one from your phone. Claude Code and Antigravity have no reset source, so those sessions do not show the section.

1. In a session, tap **Agent usage (Uso do agente)** in the chat header.
2. Find **Saved resets (Resets salvos)** under the limit cards. Each row shows the account, its provider, how many resets are saved and how many are available now ("salvos · disponíveis agora"), and when they expire.
3. Tap **Use reset (Usar reset)** on a row. The button is enabled only when at least one reset is available now.
4. A confirmation asks **Use 1 reset? (Usar 1 reset?)**. Tap **Use reset** to confirm. **Cancel (Cancelar)**, the back gesture, or a tap outside sends nothing.

**Spending a reset cannot be undone** and uses one of your account's saved resets. Nanachi runs one at a time and never retries a redeem automatically. The agent's reply appears under the section heading and the usage numbers refresh afterward.

If the app cannot tell what happened, for example when the request times out after it was sent, it says "Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo." (could not confirm whether the reset was used; check usage before trying again). Refresh the usage and check the saved count before you try again, because a second attempt could spend another reset.

Oh My Pi lists the accounts it has stored for the Anthropic and OpenAI Codex providers, and its own text is shown as it prints it. Codex shows the account the session uses. Automated tests use fake agents only.

### Model picker with many providers

Oh My Pi can connect many providers at once, such as OpenRouter, Cursor, OpenAI Codex, and Claude CLI, and the same model name often exists under several of them. When an agent's model list comes from at least two providers, the model picker groups the options by provider, and the closed **Model (Modelo)** row shows the provider under the model name. A model that arrives through OpenRouter also shows its upstream vendor after the name, such as "· Anthropic". Options with no recognizable provider are listed under "Outros" (others), and a provider the app does not know is shown by the id the agent sent.

This applies to **Configure session (Configurar sessão)**, the new-session sheet, and the `/model` picker. Agents with a single provider, such as Claude Code, look the same as before.

### Language

The app is available in Brazilian Portuguese (the default), English, and Spanish. The Spanish interface is neutral Latin American Spanish, addressing you as "tú".

1. Open **Settings → Language (Ajustes → Idioma / Language)**. In Spanish the screen is called **Configuración**.
2. Choose **Português (Brasil)**, **English**, or **Español**. The change applies immediately, without reloading.

The choice is saved on each device, so set it on every phone or browser you use. The section title and the option names stay the same in every language, so you can find the row after switching.

Not translated:

- Text that agents and the daemon send, such as agent output, session titles, their error messages, login output, and the lines Oh My Pi prints for resets.
- Command names such as `/model`.
- Push notifications. The daemon builds them in Portuguese.

## Keep it ready when you need it

### Windows launcher

Double-click `Nanachi.bat` in the project root (or run `.\Nanachi.bat` in PowerShell). It checks Node.js 22+ and npm, installs dependencies or builds when they are missing, installs the sign-in shortcut if needed, starts the supervisor, waits for the daemon on `127.0.0.1:7777`, makes sure Tailscale serves it over HTTPS (`tailscale serve --bg`, never Funnel), and shows a pairing code valid for 5 minutes. Each step prints `[ OK ]`, `[AVISO]` (warning) or `[ERRO]`. Running it again when everything is already up only prints the `OK` lines and a new code.

The window stays open until you press **R** (new pairing code) or **Esc** (close). Errors also wait for **Esc**, so the message stays on screen. `Nanachi.bat --check` is a read-only dry run: it reports what would change, starts nothing and generates no code. The launcher uses the same `npm run autostart` and `npm run pair` commands described below; the first run still needs the Tailscale and `config.json` setup above.

The launcher does not build while the supervisor is running, because the supervisor's watch build already does that.

After the first build, you can install automatic startup and start the supervisor immediately:

```powershell
npm run autostart -w @nanachi/daemon -- install
npm run autostart -w @nanachi/daemon -- start
```

This creates a shortcut in the Windows **Startup** folder without requiring administrator privileges. It starts the supervisor without a window **when you sign in**, in your user session—it is not a Windows service.

The supervisor watches code changes, rebuilds, and keeps the daemon running. This is **local code reloading**, not automatic updates through `git pull`.

<details>
<summary><strong>How reloading works and where to find logs</strong></summary>

- Changes to the daemon or `shared` wait for **60 seconds without new builds** and for no sessions to be working or awaiting permission before reloading. Configure the interval with `reloadQuietMs`.
- Idle ACP sessions are saved and resumed after reloading; terminals remain stopped. Resume failures are recorded in the log.
- PWA changes do not restart the daemon. The service worker updates the app; reopen it to get the new version.
- If the daemon crashes, the supervisor retries with increasing delays, up to 30 seconds.
- Only one supervisor instance runs at a time.
- Logs: `%USERPROFILE%\.nanachi-remote\supervisor.log`, rotated when it exceeds 5 MB. Startup errors go to `supervisor-start.log`.

To follow activity in the terminal, use `npm run supervise`. Ctrl+C stops the supervisor and its child processes. Do not run a manual daemon on the same port at the same time.

</details>

## Nanachi Desktop

Nanachi Desktop is a Windows app that runs the daemon for you. It adds a tray icon, a control panel window, and its own installer, which needs no Node.js, Git, or clone of this repository on the machine where you install it. It is a preview: it is not code-signed, no installer is distributed yet, and you build it from source (below). Read [Desktop limits](#desktop-limits) first.

### What it does

- **Runs the daemon** with its own bundled Node.js and restarts it after a crash (it stops retrying after more than 5 crashes in 2 minutes and shows an error). It has its own data folder, `%USERPROFILE%\.nanachi-desktop` (set `NANACHI_DESKTOP_HOME` to move it), separate from a standalone daemon or the supervisor, which keep using `%USERPROFILE%\.nanachi-remote`. Desktop never reads `NANACHI_HOME`, so sessions, paired devices and `config.json` are not shared with them. On a fresh folder it writes `config.json` with `"port": 7780` (an existing `config.json` is never rewritten, and its port wins), so Desktop and a standalone daemon on 7777 run side by side. The daemon's log is `desktop-daemon.log` in that folder.
- **Attaches to a daemon that is already running.** If a Nanachi daemon already answers on Desktop's port (another copy of Desktop, for example; not the supervisor on 7777 unless you point Desktop's `config.json` at it), Desktop starts nothing, shows "conectado ao daemon existente" (connected to the existing daemon), and never stops that daemon when you quit.
- **Tray icon.** The first menu line is the status: `Nanachi · rodando` (running), `· iniciando` (starting), `· conectado ao daemon existente`, `· parado` (stopped), or `· erro` (error). The items are **Abrir Nanachi** (open the control center), **Abrir sessões** (open the control center on its **Sessões** section), **Gerar código de pareamento** (generate a pairing code: a 6-digit code with its expiry and a QR code), **Iniciar com o Windows** (start in the tray when you sign in), and **Sair** (quit). Quitting stops the daemon only if Desktop started it.
- **Control center.** The main window is a desktop control panel for this PC, with its own title bar and a sidebar: **Visão geral** (overview: daemon, built-in Tailscale, activity), **Pastas e discos** (folders and drives), **Aparelhos** (paired devices and pairing codes), **Contas dos agentes** (agent accounts), **Tailscale**, **Logs**, **Ajustes** (settings: language, start with Windows, updates, uninstall), and **Sessões** (the sessions and chat, below). Ctrl+1 to Ctrl+8 switch sections and Ctrl+B collapses the sidebar (on **Sessões** it is always the narrow icon rail, whatever you saved). The window cannot be made smaller than 980 x 620. Closing the window keeps Desktop running in the tray.
- **Folders and drives.** **Pastas e discos** edits `allowedRoots` in Desktop's `config.json`: pick folders with the Windows folder picker or allow a whole drive. Saving restarts Desktop's own daemon; every session comes back stopped and resumes on its next message, and the app asks first when sessions are busy. Only the PC can change this list; the phone only reads it. It chooses where sessions can open; it is not a sandbox.
- **Sessions.** The **Sessões** section (Ctrl+8; the **Abrir sessões** buttons and the tray item go there) shows this same web app, loaded from the local daemon, inside the control center window, for the sessions and chat, with an extra **Desktop** group in its Settings. While the daemon is starting, stopped, failed, or only accepts Tailscale, the section explains that instead. The web app there is in its wide layout (a list of workspaces and sessions beside the screen), because the window cannot get smaller than that layout needs. There is no separate sessions window. If the web app's page keeps closing (twice within 30 seconds), the section says so and tries again when you open it again. On first run Desktop registers itself as a device named "Nanachi Desktop (PC name)", shown as **Este app** in **Aparelhos**.
- **Languages.** Português (Brasil), English and Español. On its first run Desktop takes the language of Windows (anything other than Spanish or Portuguese becomes English); change it in **Ajustes → Idioma**. The control center, the tray menu, Desktop's messages and the web app inside **Sessões** switch at once. The web app switches live, without reloading, and keeps a language you later choose inside it until Desktop's own language changes again. A Desktop installed before the languages existed stays in Português (Brasil) until you change it. The installer speaks the language the installed Desktop is set to (the Windows language on a first install); the uninstaller uses the language Desktop saved.

### Build it

You need Windows x64, **Node.js 22** (the packaging script refuses other major versions, because it bundles a copy of that Node), and Go for the Tailscale sidecar. `packages/desktop/tsnet/go.mod` requires Go 1.27.3. Install a current Go: unless `GOTOOLCHAIN` is set to `local`, the `go` command downloads the required toolchain on first use.

The packaging script does not compile the daemon, `shared`, or the web app. It copies their existing build output, so build them first. If the supervisor is running, its watch build has already done it and you can skip `npm run build`.

```powershell
npm install
npm run build
npm run package -w @nanachi/desktop
```

Add `-- --fresh` after the package command to rebuild the staged runtime, or `-- --skip-installer` to stop after the unpacked app.

The build folder reaches several GB (the first build used about 4.5 GB), so it goes under `%LOCALAPPDATA%\nanachi-desktop-build` instead of the repository, which may live in OneDrive. Set `NANACHI_DESKTOP_BUILD_DIR` to another absolute path outside the repository to move it:

| Output | Path inside the build folder |
| --- | --- |
| Installer | `release\Nanachi-Setup-<version>.exe` |
| Unpacked app | `release\win-unpacked\Nanachi.exe` |
| Tailscale sidecar | `stage\bin\nanachi-tsnet.exe` |

The root `npm run build` does not build Desktop, so a Desktop build problem cannot stop the supervisor.

### Install and uninstall

Run `Nanachi-Setup-<version>.exe`. It opens its own window instead of a Windows wizard: **Instalar** (install), a progress bar, then **Abrir o Nanachi** (open Nanachi). **Opções** (options) changes the install folder, the desktop shortcut, and start with Windows; the last two are on by default. If Nanachi Desktop is running, the installer asks to close it.

The install is per user and does not ask for administrator rights. The default folder is `%LOCALAPPDATA%\Programs\Nanachi`. It creates a Start Menu shortcut, a desktop shortcut unless you turn that off, and an uninstall entry for your user.

To uninstall, remove **Nanachi** in Windows **Settings → Apps**, or run `Nanachi.exe --uninstall` from the install folder. A confirmation window opens and stops the daemon Desktop owns. Desktop's data folder (`%USERPROFILE%\.nanachi-desktop`: sessions, devices, `config.json`) is kept unless you tick **Apagar também os dados do Nanachi** (also delete Nanachi's data), which deletes only that folder and Desktop's own profile. It always refuses the standalone daemon's folder, `%USERPROFILE%\.nanachi-remote`, and the folder named by `NANACHI_HOME` when that is set.

### Built-in Tailscale

The **Tailscale embutido** switch in Settings → Desktop starts a small sidecar (`nanachi-tsnet`, built on Tailscale's `tsnet`) that serves the daemon over HTTPS. It is off by default.

1. Turn it on and use **Entrar no Tailscale** (sign in to Tailscale) to approve this PC. It joins your tailnet as a separate device named `nanachi-<PC name>`. The Tailscale app installed on Windows, `tailscale serve`, and Funnel are not touched.
2. When it connects, the panel shows **Endereço para o iPhone** (address for the iPhone), an `https://` address on your tailnet.
3. On the iPhone, install the Tailscale app, sign in with the same account, open that address in Safari, and add it to the Home Screen. Pair with the code from **Gerar código de pareamento**.

The tailnet needs **MagicDNS** and **HTTPS Certificates** enabled, the same as for `tailscale serve`. If your tailnet requires device approval, approve the new device in the Tailscale admin console. The sidecar sends the same identity headers as `tailscale serve`, so `allowedTailscaleLogins` still applies to phones that connect through it. You do not need it if you already use `tailscale serve` as described above.

### Updates

On start and from **Procurar atualização**, Desktop asks GitHub for the latest release of this repository (without a token). If a newer release has a `Nanachi-Setup-*.exe` asset, the panel shows **Nova versão** (new version) with a link to the release page. Desktop never downloads or installs anything by itself.

### Desktop limits

- **Not code-signed.** Windows SmartScreen will warn that the publisher is unknown.
- **Large.** The installer is about 850 MiB (844 MiB for the first build) and the installed app about 1.3 GiB, mostly Electron, Node.js, and the native binaries of the Claude Code and Codex SDKs.
- **Windows x64 only.**
- **Support logs stay in Portuguese.** `desktop-daemon.log` and the installer log are written in Portuguese, for support; everything you read in a window, the tray, or a dialog follows [Desktop's language](#nanachi-desktop).
- **The local panel needs an empty `allowedTailscaleLogins`.** With that list set, the daemon refuses requests that carry no Tailscale identity, and the panel comes from `127.0.0.1`, so it shows an explanation page instead of the app. Desktop's own `config.json` (in `.nanachi-desktop`) has no allowlist unless you add one, and the daemon's authentication is unchanged. An empty list accepts any tailnet login that Tailscale forwards, but a device token is still required. Read [Security](#security-without-the-fine-print) before relying on that, and keep the list empty only in Desktop's folder.
- **Not tested on a clean machine or a real iPhone.** The unit tests, the Go tests, and the smoke scripts use temporary folders and a fake sidecar. Not checked: the installer on a fresh Windows, the SmartScreen prompt, the Tailscale login and HTTPS serving to a phone through the built-in node, and start with Windows after a reboot.

## More than one PC

Each PC has its own daemon and data. Install the web app once, then add your other machines to it.

1. Repeat the setup on the second PC, including configuration and Tailscale Serve.
2. In **the second PC's** `config.json`, authorize the HTTPS origin from which you installed the app:

   ```json
   "corsOrigins": ["https://main-pc.my-tailnet.ts.net"]
   ```

3. Restart the second daemon, generate a code on that PC, and tap **Pair machine (Parear máquina)** on your phone. Use the second PC's HTTPS address and its code.
4. For notifications from all PCs, copy `vapid.json` from the main PC's `.nanachi-remote` folder to the same data folder on the other PCs, **before starting the destination daemons and enabling notifications**. If they are already running, stop them first and restart them afterward. All machines need the same key. Re-enable notifications in the app if they were already configured.

**`vapid.json` contains a private key.** Transfer it only between your own PCs through a secure channel, and never commit it.

## Security, without the fine print

Nanachi lets you control processes running as **your Windows user**. Treat a paired phone as a key to your PC.

- The daemon listens only on loopback; remote access must go through **Tailscale Serve**.
- Use `allowedTailscaleLogins` and your tailnet's access rules to limit who can reach the service.
- Each device receives its own token. The database stores its hash, not the original token. Pairing codes expire after 5 minutes and have an attempt limit.
- **`allowedRoots` does not isolate the agent.** It can access other folders with your user's permissions. Use the agent's approval modes, especially with third-party projects.
- Lost your phone? Revoke it under **Settings → Devices on this machine (Ajustes → Dispositivos desta máquina)** or through the CLI below. Revocation closes the connection.
- Do not publish `config.json` with personal data, `data.db`, `vapid.json`, tokens, attachments, or logs from your data folder. The `accounts` folder there holds the credentials of extra [agent accounts](#agent-accounts).
- Do not use Funnel or expose the daemon's port to the internet.

<details>
<summary><strong>Protection details and limits</strong></summary>

The daemon validates Host and Origin, restricts additional origins through `corsOrigins`, and checks the login forwarded by Tailscale. The `/api/agent/*` routes used by `phone-send` reject proxied requests. Agent tokens are session-specific, exist only in memory, and become invalid when the daemon stops.

Each session allows up to **200 files and 500 MiB**, counting both directions. File notifications have a minimum interval of 60 seconds per session. PNG, JPEG, GIF, and WebP can appear inline; other downloads are sent as `application/octet-stream`.

The push service accepts only HTTPS endpoints from the providers allowed by the daemon (FCM, Mozilla, WNS, and Apple). Expired subscriptions returning 404 or 410 are removed.

</details>

## Useful commands

Run these from the repository root. Startup commands use the output of `npm run build`.

| Command | Purpose |
| --- | --- |
| `npm run start -w @nanachi/daemon` | Run the daemon in the terminal. |
| `npm run pair -w @nanachi/daemon` | Generate a code for a new device. |
| `npm run devices -w @nanachi/daemon` | List devices and their IDs. |
| `npm run revoke -w @nanachi/daemon -- <id>` | Revoke a device. Replace `<id>` with its listed ID. |
| `npm run autostart -w @nanachi/daemon -- status` | Show automatic startup and supervisor status. |
| `npm run autostart -w @nanachi/daemon -- stop` | Stop the supervisor and its child processes. |
| `npm run autostart -w @nanachi/daemon -- uninstall` | Remove the sign-in shortcut; does not stop running processes. |
| `npm run vapid -w @nanachi/daemon -- show` | Show the push key path and its public part. |
| `npm run supervise` | Build and watch builds and the daemon in the terminal. |
| `npm run package -w @nanachi/desktop` | Build the [Nanachi Desktop](#nanachi-desktop) installer from the existing build output. |

<details>
<summary><strong>config.json reference</strong></summary>

The default data folder is `%USERPROFILE%\.nanachi-remote`. To use another location, set `NANACHI_HOME` in the environment of **every** daemon and CLI command.

| Field | Default | Purpose |
| --- | --- | --- |
| `port` | `7777` | Local port; also update the Tailscale Serve target if you change it. |
| `host` | `127.0.0.1` | Accepts only `127.0.0.1`, `::1`, or `localhost`. |
| `machineName` | PC name | Name displayed in the app. |
| `allowedRoots` | `[]` | Roots available when choosing workspaces. |
| `allowedTailscaleLogins` | `[]` | Authorized logins; an empty list accepts any login forwarded by Serve. |
| `corsOrigins` | `[]` | Additional origins, such as the main PC's origin in a multi-machine setup. |
| `phoneSendHint` | `true` | Tells the agent about `phone-send` in the first prompt of a new ACP session. |
| `reloadQuietMs` | `60000` | Quiet period without new builds before the supervisor reloads. |
| `agents` | omp, claude, codex, agy | Agent map with `label`, `command`, `args`, `env`, and `kind` (`acp` or `pty`). |

An entry in `agents` overrides the default for the same ID. Default agents not defined in the file remain available in memory. Restart the daemon after editing the configuration.

</details>

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The address does not open on your phone | PC powered on, daemon running, Tailscale connected on both devices, and the correct HTTPS address from `tailscale serve status`. |
| No folder appears when creating a workspace | `allowedRoots` must contain at least one existing folder. Restart the daemon after editing it. |
| Invalid or expired code | Generate another with `npm run pair -w @nanachi/daemon`; each code works once and lasts 5 minutes. |
| Android only creates a shortcut | Use up-to-date Chrome, HTTPS, and a normal tab. Look for **Install app** or **Add to Home screen → Install**. |
| Notifications do not arrive | Check system/browser permissions, an active Tailscale connection, and the same VAPID key across PCs. On iPhone, use iOS 16.4+ and open the installed icon. |
| Notifications stopped working | Enable them again in **Settings (Ajustes)**; the subscription may have expired. On Android, also check battery restrictions. |
| WebSocket does not connect | Make sure the proxy forwards origin headers. If needed, add the app's HTTPS origin to `corsOrigins` and restart. |
| The agent does not start | Try its command in the terminal and check PATH and login. Install `omp` and `agy` separately. |
| Antigravity asks for login or folder trust | Open `agy` once on your PC and answer its prompts in the desired folder. |
| Screenshots are black | Run the daemon in your user's desktop session. A Windows service cannot see the same desktop. |
| Port 7777 is in use | Do not mix a manual daemon and supervisor on the same port. If you change `port`, update Tailscale Serve too. |
| Nanachi Desktop shows "O painel local não consegue usar este daemon" | `allowedTailscaleLogins` is set in Desktop's `config.json` (`%USERPROFILE%\.nanachi-desktop`) and the local panel has no Tailscale identity. Empty the list. See [Desktop limits](#desktop-limits). |
| A reset's result is unclear ("Não deu para confirmar...") | Refresh the usage and check the saved resets count before trying again. See [Saved rate-limit resets](#saved-rate-limit-resets). |
| Error reading `config.json` | Check for valid JSON and inspect the field named in the message. PowerShell 5.1's UTF-8 BOM is accepted. |

## Working on the code

This is an npm workspaces monorepo:

```text
packages/
  shared/   Protocol types and Zod schemas
  daemon/   Fastify API, WebSocket, SQLite, agents, and CLI
  pwa/      React, Vite, service worker, and mobile interface
  desktop/  Nanachi Desktop: Electron shell, tray, installer, and the Go Tailscale sidecar
e2e/        End-to-end scenarios with Playwright and Edge
```

```powershell
npm install
npm run build
npm test
npm run typecheck
```

For integrated reloading, use `npm run supervise`. You can also use `npm run dev -w @nanachi/daemon` and `npm run dev -w @nanachi/pwa` to work on individual packages; build `shared` first. Vite proxies `/api` and `/ws` to `127.0.0.1:7777`. Check installation and notifications with the **built PWA served over HTTPS**, not just the development server. `npm run dev -w @nanachi/desktop` compiles Nanachi Desktop and starts it in Electron against the repository's daemon build, so run `npm run build` first.

<details>
<summary><strong>End-to-end tests</strong></summary>

After `npm run build`, the following scenarios start temporary daemons and use test agents without consuming an AI account. They require Windows, Node 22+, Microsoft Edge, and free ports for each scenario. Generated screenshots are saved in `e2e/screenshots/`, which is not version-controlled.

| Command | Scenario |
| --- | --- |
| `npm run e2e:34` | Attachments, files sent from the PC, terminal, and notifications. |
| `npm run e2e:5` | Multiple PCs, worktrees, devices, and origin control. |
| `npm run e2e:resume` | Session listing, import, and removal. |
| `npm run e2e:images` | Chat images and image viewer. |
| `npm run e2e:commands` | `/` command menu and sending commands through chat. |
| `npm run e2e:chatperf` | Long chats, scrolling, and message rendering. |

The basic `npm run e2e` is different: it requires a configured daemon on port 7790, an authorized root, and a pairing code. It uses the real agent. Example: `npm run e2e -- --pair-code <code> --root-name <name>`. Read the requirements at the beginning of each script before running it. `E2E_BROWSER_CHANNEL=chrome` switches the browser for scripts that support that option.

Browser scenarios with an iPhone viewport help check the interface, but **do not replace testing installation, keyboard behavior, and push on a real Android phone or iPhone**.

</details>

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. External contributors should fork the repository and open a pull request for review by **@j-carv**. The repository is public, but public visibility does not grant write or merge access.

---

Built to follow your work from anywhere without handing control of your PC to a public dashboard. Start with one machine, one project, and one agent; add the rest when you need it.
