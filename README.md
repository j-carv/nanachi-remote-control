<div align="center">
  <img src="packages/pwa/public/icon-512.png" alt="Nanachi Remote logo" width="160" />

  <h1>Nanachi Remote · Desktop 1.0.1</h1>
  <p>By <strong>Everward Research</strong></p>

  <p><strong>Control the coding agents on your Windows PC from your phone.</strong></p>
  <p>Nanachi Desktop runs the local control center and tray app. The mobile web app lets you continue chats, review changes, send files, and answer your agents over your private Tailscale network.</p>

  <p>
    <a href="https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.0.1"><img src="https://img.shields.io/badge/Desktop-1.0.1-8B5CF6?style=flat-square" alt="Desktop 1.0.1" /></a>
    <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/Desktop-Windows%20x64-0078D4?style=flat-square" alt="Windows x64 Desktop" /></a>
    <a href="#install-on-your-phone"><img src="https://img.shields.io/badge/PWA-Android%20%2B%20iPhone-8B5CF6?style=flat-square&logo=pwa&logoColor=white" alt="Web app for Android and iPhone" /></a>
    <a href="https://www.tailscale.com/"><img src="https://img.shields.io/badge/Network-Tailscale-242424?style=flat-square&logo=tailscale&logoColor=white" alt="Connection through Tailscale" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.9" /></a>
  </p>

  <p><sub><em>Disclaimer: Nanachi is a character from <strong>Made in Abyss</strong>, created by Akihito Tsukushi and published by Takeshobo; the anime adaptation is produced by Kinema Citrus. All rights to the character and the series belong to their respective owners. This is an unofficial fan-named Open-Source Project with no affiliation with, or endorsement by, the author, the publisher, or the studio.</em></sub></p>

  <p><a href="#get-started-on-your-pc">Windows download and setup</a> · <a href="#install-on-your-phone">Android and iPhone</a> · <a href="#everyday-use">How to use it</a> · <a href="#from-source-standalone-daemon">From source</a> · <a href="#troubleshooting">Help</a></p>
</div>

---

**Windows x64:** [Nanachi Desktop 1.0.1 release page](https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.0.1) · [Download `Nanachi-Setup-1.0.1.exe`](https://github.com/j-carv/nanachi-remote-control/releases/download/v1.0.1/Nanachi-Setup-1.0.1.exe)

> **Windows x64 · unsigned installer.** Windows may show an unknown-publisher or SmartScreen warning. Clean-Windows installation and physical-phone testing have not been completed. Read [Desktop limits](#desktop-limits) before installing.


## Why Nanachi?

Nanachi, from *Made in Abyss*, is a guide who is always on the move, keeps watch over the people in her care from wherever she is, and lives quietly in a hideout in the depths. Nanachi Remote borrows those traits:

- **Always on the move, always watching.** Nanachi keeps watch from anywhere; the app lets you watch your agents from your phone.
- **Sees what others cannot.** Nanachi can sense the Abyss's force field, which others cannot see; the app shows what your agents are doing on your PC.
- **A caretaker for explorers.** Nanachi is a resourceful guide who looks after the explorers she travels with; the app looks after your sessions and tells you when you are needed.
- **Quiet and hidden.** Nanachi makes a home in a hideout far from the surface; the daemon runs quietly on your PC.

---

## The idea

Leave an agent working on Windows and continue the conversation from your phone. Nanachi organizes projects and sessions, displays chat and terminal output, accepts attachments, and lets you know when you are needed. The Windows Desktop app bundles the local daemon and web app; your phone installs that web app as a PWA, not an APK or App Store app.

Your own PC serves the dashboard inside your Tailscale network. **There is no need to host a cloud backend, forward router ports, or use WSL.** Desktop can use its optional built-in Tailscale node or your existing Tailscale Serve installation. Agents still need their own setup, accounts and model access—Nanachi does not supply a subscription, make model inference free, or make cloud models run offline.

> Your PC must be powered on, connected to the tailnet, and running Nanachi. Your phone is the remote control, not where the agent runs. Scheduling also requires the PC and daemon to stay running.

**Everward Cloud** will offer a relay for remote access without requiring Tailscale.

### What you can do

- **Run a Windows control center and tray app** with a bundled runtime, folder selection, device pairing, diagnostics, logs and optional built-in Tailscale. No user-installed Node.js or repository clone is needed to install Desktop.
- **Chat with configured ACP agents** with streaming replies, Markdown, code, permission cards, plans and [compact tool activity](#read-tool-activity).
- **Choose model, access, and effort settings** when the agent supports them. Long model lists are [grouped by provider](#model-picker-with-many-providers); `/` commands come from the agent.
- **Resume PC sessions** when the agent supports listing and reopening its history, and search saved sessions and messages.
- **Keep several logins** for Claude Code and Codex and [switch accounts](#agent-accounts) per session. Inspect usage and [saved rate-limit resets](#saved-rate-limit-resets) where supported.
- **Send photos and files**, and opt into [Nanachi MCP](#photos-files-and-screenshots) for PC screenshots, files sent back to your phone, explicit questions, requested uploads and [private project previews](#open-a-private-project-preview).
- **Keep global memory and reusable procedures** in local SQLite, shared across the PC's workspaces with automatic source-project identification. [Automatic learning](#memory-and-automatic-learning) is opt-in, with configurable reviewers, optional approval and reversal; agents decide when to retrieve memory rather than having it injected into every prompt.
- **Dictate a draft** with [local Whisper or a configured transcription API](#dictate-a-chat-message), review it, then send. Voice dictation does not send messages automatically.
- **Schedule workspace tasks** as [agent runs or direct shell commands](#schedule-workspace-tasks), with timezone-aware timing, pause/manual execution, deadlines, cancellation and separate execution history.
- **View Git changes and commit history**, and open sessions in separate worktrees. Git must be installed for these operations.
- **Use Portuguese, English or Spanish**, switch between PCs, mute workspace notifications and revoke paired devices.
- **Receive notifications** when the OS and browser permit them. A device viewing a session's chat does not receive push notices for that session.

### Agents

| Agent | How it appears in the app | What to prepare on your PC |
| --- | --- | --- |
| Oh My Pi (`omp`) | Chat through ACP | Install `omp`, add it to PATH, and configure your account. |
| Claude Code | Chat through ACP | Sign in locally; the `claude-agent-acp` adapter is included with the daemon. |
| Codex | Chat through ACP | Sign in locally; the `codex-acp` adapter is included with the daemon. |
| Antigravity (`agy`) | Chat through ACP | Install `agy` and sign in from your PC's terminal. Run `agy acp --help` to see the sign-in options for your version. |

ACP is the protocol used to communicate with agents. Model lists, input types, permissions, commands, usage reporting and session history/resume vary by agent and adapter; Nanachi does not promise every model or capability for every agent. Prepare the agent binaries and sign-ins you intend to use. Bundled ACP adapters are integration components, not preconfigured AI accounts.

## Before you install

For **Nanachi Desktop**, the recommended Windows path:

- **Windows x64.** Windows 11 is the project's development environment; this is not a claim of validation on every Windows version.
- An agent from the [table above](#agents), with the required local setup and account/model access.
- A Tailscale account and tailnet. Desktop's optional **Tailscale embutido** (built-in Tailscale) does not require the Windows Tailscale app; alternatively, install that app and use Serve.
- [Git](https://git-scm.com/) on PATH **if you want Git changes, commit history or worktrees**, or your agent/project requires it.

**Installing the bundled Desktop app does not require Node.js, npm, Git, Go or a clone of this repository.** Those are separate from agent/project requirements. Developers running the standalone daemon need the [from-source prerequisites](#from-source-standalone-daemon); building the Desktop installer also needs the [Desktop build tools](#build-it).

On your **phone**:

- Tailscale installed, with access to the same tailnet as your PC.
- **Android:** an up-to-date Chrome browser is the recommended way to install the web app.
- **iPhone:** Safari. Notifications require **iOS 16.4 or later** and the app installed on the Home Screen.

In the [Tailscale admin console](https://login.tailscale.com/admin/dns), enable **MagicDNS** and **HTTPS Certificates** under DNS. Your phone needs access to the PC's Nanachi node under your tailnet's access rules. Use private Serve or the built-in node, never Funnel.

## Get started on your PC

### Recommended: install Nanachi Desktop 1.0.1

1. Open the [v1.0.1 release page](https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.0.1) and download [`Nanachi-Setup-1.0.1.exe`](https://github.com/j-carv/nanachi-remote-control/releases/download/v1.0.1/Nanachi-Setup-1.0.1.exe) for **Windows x64**.
2. Run the installer, choose **Instalar** (Install), then **Abrir o Nanachi** (Open Nanachi). The app is unsigned; Windows may show an unknown-publisher or SmartScreen warning. Download only from the project's release page and decide whether you trust it. See [install options and uninstall](#install-and-uninstall).
3. In **Pastas e discos** (Folders and drives), choose the folders where sessions may open, then **Salvar** (Save). This is workspace selection, **not a sandbox** for agent tools.
4. Prepare your agent's local sign-in and required binaries, then open **Sessões** (Sessions) to use the app on this PC. To add supported extra Claude Code/Codex logins, use **Ajustes → Contas dos agentes** inside the sessions app; Desktop's **Contas dos agentes** sidebar section chooses the account for new sessions. Neither supplies provider access.
5. For phone access, open **Tailscale**, turn on **Tailscale embutido**, and choose **Entrar no Tailscale** (Sign in to Tailscale). Approve the new node if your tailnet requires it. Copy **Endereço para o dispositivo móvel** (Address for your mobile device). If you prefer an existing Windows Tailscale installation, leave the built-in node off and [configure Serve](#3-make-it-available-on-your-tailnet) for Desktop's configured port—**7780 by default**, not the standalone daemon's 7777.
6. Open **Aparelhos → Parear novo aparelho** (Devices → Pair new device), or **Gerar código de pareamento** (Generate pairing code) in the tray. A code lasts **5 minutes** and works once. When a private HTTPS address is available, Desktop also shows a QR code that opens that PC and pairs the device.
7. Continue with [Install on your phone](#install-on-your-phone). On iPhone, open the installed Home Screen app for pairing and notifications; the QR flow first explains installation.

Desktop keeps its data in `%USERPROFILE%\.nanachi-desktop`, separate from the standalone daemon's `.nanachi-remote` folder. It does not import your existing standalone sessions, devices or configuration automatically. Closing its window leaves it in the tray; **Sair** (Quit) stops the daemon it owns. **Iniciar com o Windows** starts Desktop when you sign in, not as a Windows service.

The app uses Portuguese, English or Spanish; Desktop initially follows the Windows language, falling back to English. This guide includes the Portuguese labels with English meanings. Read [Nanachi Desktop](#nanachi-desktop) for control-center details, data paths and limitations.

## From source: standalone daemon

Use this path to run the daemon without Desktop or work on the code. You need **Windows**, [Node.js 22 or later with npm](https://nodejs.org/), [Git](https://git-scm.com/) on PATH, the [Windows Tailscale app](https://tailscale.com/download) installed and connected, and your chosen agents configured. Desktop packaging has [additional requirements](#build-it).

Run the following commands from PowerShell or your preferred Windows terminal. After cloning, run the remaining commands from the project root.

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

For a standalone daemon, use **another terminal**. For Desktop with its built-in Tailscale node off, replace `7777` below with Desktop's configured port (**7780** on a fresh install).

```powershell
tailscale serve --bg http://localhost:7777
tailscale serve status
```

Save the HTTPS address shown, such as `https://my-pc.my-tailnet.ts.net`. This is the address you will open on your phone. If your Tailscale version has different options, see the [Serve reference](https://tailscale.com/kb/1242/tailscale-serve).

> **Use `tailscale serve`, never `tailscale funnel`.** Serve keeps access within your tailnet; Funnel publishes the service on the internet. Do not forward Nanachi's ports on your router.

### 4. Generate a pairing code

With the daemon running:

```powershell
npm run pair -w @nanachi/daemon
```

This displays a **6-digit code**, valid for **5 minutes** and usable only once. Now switch to your phone.

Desktop users should use **Aparelhos → Parear novo aparelho** (Devices → Pair new device) or the tray's **Gerar código de pareamento** instead of this CLI. The repository commands use the standalone data folder unless you explicitly select another home.

## Install on your phone

Use the HTTPS address from Desktop's **Tailscale** section, its pairing QR code, or `tailscale serve status` for a manual Serve setup. Both Android and iPhone need the Tailscale app and private access to that address. The mobile app defaults to Brazilian Portuguese; English and Spanish are available under [Language](#language). This README gives Portuguese labels with their English meanings.

### Android

1. Open **Tailscale** on Android, sign in, and make sure it is connected to the same tailnet as your PC.
2. In **Chrome**, open the PC's Nanachi HTTPS address from Desktop or `tailscale serve status`.
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

**Code expired?** Generate another under Desktop's **Aparelhos → Parear novo aparelho**, from the tray, or with the [standalone pairing command](#4-generate-a-pairing-code). Each device needs its own pairing. If a QR code already paired the device, you do not need to enter the code again.

## Everyday use

### Open a project and start chatting

1. Select your PC on the machines screen.
2. Tap **+ Workspace**, browse to an authorized folder, and choose **Use this folder (Usar esta pasta)**.
3. Inside the workspace, tap **New session (Nova sessão)**, choose an agent, and adjust the options it provides.
4. Tap **Create session (Criar sessão)** and send your message.

Model, access, and effort selectors depend on the agent, and the app remembers your last choice for each one. Permission requests appear as cards in chat. **Stop (Parar)** interrupts the current work.

Type `/` at the beginning of a message to see the commands the agent has advertised. If it does not advertise commands, there is no universal list to display.

The app saves unsent text and your reading position for each chat on this device. When you return to a chat with new activity, look for **New messages (Novas mensagens)** at the first unread message. Press and hold a message, or right-click it, to copy it or quote it in your next draft. For your own messages, **Edit and resend (Editar e reenviar)** brings the text back to the composer for review.

When the agent publishes a structured plan, **Plano** (Plan) stays above the message field with the current step and completed/total count. Tap it to expand or collapse the checklist without leaving the chat; long plans scroll inside the panel. It updates as the agent reports progress, remains available when its original card is outside the visible history, and disappears if the agent clears the plan. Plans written only as ordinary chat text do not create this panel.

The session list puts sessions awaiting permission first, followed by sessions with errors.

### Read tool activity

Consecutive tool calls appear as compact, expandable activity groups instead of filling the chat with every operation. The summary shows the current action or completion count; expand it to inspect the individual calls and their available details. Failed calls, including failures inside nested activity, remain visible outside the collapsed summary. What Nanachi can show depends on the tool events the agent sends.


### Work modes

The chat header shows a **Modo de trabalho** (Work mode) chip. Tap it to see the agent's modes, when available, and Nanachi's **YOLO** setting. Each kind of agent mode has one name in the app, whichever agent it comes from:

- **Claude Code:** **Perguntar antes de editar** (Ask before editing, its default), **Aceitar edições automaticamente** (Accept edits automatically), **Planejamento** (Planning), **Modo automático** (Automatic mode), and **Ignorar permissões** (Bypass permissions), when the adapter allows it on this PC.
- **Codex:** **Somente leitura** (Read-only), **Aceitar edições automaticamente** (its "Workspace access"), **Modo automático** (its "Auto review"), and **Ignorar permissões** (its "Full access").
- **Antigravity:** **Perguntar antes de editar** (Ask before editing, its default), **Aceitar edições automaticamente** (Accept edits automatically), and **Planejamento** (Planning).
- **Oh My Pi:** limited to **Modo automático** (Automatic mode), its `default`, because its approval policy is yolo and it runs tools and edits without asking.

A mode the app does not recognize keeps the agent's own name.

Switching into **Ignorar permissões** (Bypass permissions), or into Codex's full access, asks for confirmation first, because the agent then runs tools and changes files without asking. A bypass mode is not restored for new sessions: if the remembered choice for an agent is a bypass mode, a new session starts in the agent's own default mode.

**YOLO** starts off for each running chat session. Turn it on from the work mode menu to let Nanachi approve recognized single-file reads, edits, and creations of supported text files in the current workspace. Each approval appears in chat and applies to one request. Deletions, database operations, shell commands, and requests with insufficient details still go through manual review when the agent sends them. The menu flags limited coverage for adapters or modes that can skip requests or omit the details needed for automatic approval. The setting resets when the agent process stops, including after a daemon restart.

### Queue chat messages

While the agent is working or waiting for permission, use **Colocar na fila** (Add to queue) to send your next message and any attachments. Messages appear above the composer and are sent in order as turns finish. You can remove a message before it starts. The queue is shared with paired devices viewing the same session and holds up to ten messages. Ending the session or restarting the daemon clears its queue.

### Schedule workspace tasks

Open a workspace's **…** menu and choose **Agendamentos** (Schedules). On wide screens, use the workspace's menu in the left pane. Scheduling belongs to the workspace, not a chat: executions have their own history and do not appear in ordinary conversation lists or message search.

Choose **Novo agendamento** (New schedule), then one of two task types:

- **Tarefa de agente** (Agent task): select a configured ACP agent and account, enter instructions, and optionally select a model. **Descobrir modelos** (Discover models) opens a temporary agent connection to inspect its actual choices without sending an inference prompt. You can also enter a model ID. An explicitly selected model must be available and applied before the task is submitted; it never silently falls back to another model.
- **Comando direto** (Direct command): choose an installed shell and enter a foreground command. Commands run noninteractively in the workspace directory and obey the existing `shellSessions` setting. The command's exit code and stdout/stderr are recorded.

Select hourly, daily, weekday or weekly timing, or enter a **five-field cron expression** in **Cron personalizado** (Custom cron). Set the IANA timezone explicitly; **Ver próximas 5 execuções** (Preview next 5 executions) shows the actual upcoming dates in that timezone. For example, `0 9 * * 1-5` means 09:00 on weekdays in the saved timezone, not necessarily the PC's current timezone.

New schedules start **paused**. Save and confirm the task, then choose **Ativar** (Enable) when it should run automatically. **Executar agora** (Run now) also works while paused and requires explicit confirmation. Pausing or editing changes future executions, not an execution already in progress; use its history's cancellation action to stop that run.

The daemon stores schedules in SQLite and runs them while the phone is closed. The PC and daemon must be running. Missed slots after downtime or a long suspend are recorded and skipped, not replayed in a burst. An execution interrupted by a daemon crash is marked interrupted and its schedule is paused; inspect possible partial effects before enabling it again.

Only one execution of a given schedule can run at once, with at most four scheduled executions across the PC. Busy slots are recorded as missed rather than queued. Different schedules can overlap and share the workspace. Each execution has a deadline, including agent startup and permission waits. Command process trees are owned and terminated on cancellation, timeout or completion; do not use a scheduled command to launch a persistent background service.

**Histórico de execuções** (Execution history) shows the latest 100 runs, status, task snapshot, exit code/error and bounded output, with an explicit truncation indicator. **Abrir execução** (Open execution) opens an agent run's dedicated conversation when you need its full history or existing approval controls. Scheduling never turns on Nanachi YOLO or answers permissions automatically; an agent's own native policy still applies. Scheduled turns do not trigger an extra automatic-learning reviewer, but opted-in MCP tools remain available to the agent.

**Execution authority:** both task types run with the PC user's permissions. `allowedRoots` selects workspaces; it is not a sandbox. Tasks can change files, access the network and incur provider costs. Cancellation does not undo external effects or guarantee a provider stops charging. Deleting a schedule cancels its active execution and removes its owned history; cleanup that cannot finish safely remains pending for retry. History cleanup refuses live or resuming conversations and excludes new resumes until attachment deletion finishes.


### Pick up where you left off

- **Resume (Retomar):** reopens a stopped or failed session when the agent supports resuming.
- **Resume from PC (Retomar do PC):** lists the agent's sessions for that workspace and lets you bring them into the app when listing is supported.
- **End (Encerrar):** stops the process but keeps the session in the list.
- **Remove from app (Remover do app):** deletes the session's record, events, and files from Nanachi. If it is working, it will be interrupted. This **does not delete the agent's own history**.

A session can be resumed only when the agent announces that it can load or resume sessions over ACP (`loadSession` or `sessionCapabilities.resume`). If an agent does not support resuming, create a new session.

### Find sessions and messages

The search field at the top of the session list, **Buscar sessões e mensagens** (Search sessions and messages), works in two ways:

- **Sessions:** as you type, the list keeps the sessions whose title, agent, branch, or workspace name contains every word you typed. The words may be in different fields. Case and accents do not matter.
- **Messages:** after a short pause, the app searches your messages and the agent's replies. Sessions with a match are listed under **Mensagens** (Messages), with the text of their newest match. Message search starts at two characters. Inside a workspace, it searches only that workspace.

Message search matches the start of words, so `test` finds `testing`. All the words of a query must be in the same stored piece of a message. The app stores an agent's reply in pieces as it streams, so a phrase that spans two pieces is not found.

### Photos, files, and screenshots

Use the paperclip in chat to attach photos or files. Images are sent as images when the agent accepts that input type; otherwise, it receives the file path.

Nanachi includes an optional MCP server with `phone_send` for files and PC screenshots, `ask_user` for explicit decisions, `request_file` for a file from your phone, `open_preview` for a private local-app preview, and opt-in `memory`/`skills` tools for globally shared knowledge with automatic workspace context. Open **Ajustes → Nanachi MCP** (Settings → Nanachi MCP) on the selected PC and enable only the agents you want. **All agents start disabled.** Only configured ACP agents appear; terminal sessions cannot connect through MCP.

The choice applies when an agent process next starts: a new session, an imported PC session, or a stopped session that is resumed. Already-running sessions keep their current tools until stopped, so changing a switch does not interrupt work. The selection is saved per PC in `<NANACHI_HOME>/mcp.json`; it does not install global MCP configuration or store session credentials there.

Enabled agents discover `phone_send` through MCP, without an instruction appended to the user's prompt. The tool accepts either `path` (absolute or relative to that session's workspace) or `screenshot: true`, plus an optional `caption`. Delivery uses the same file limits, authentication, chat and notifications as the command below.

To send from PC → phone, an agent running inside a Nanachi session can use:

```powershell
phone-send "C:\Projects\my-app\result.png" --caption "Here is the result"
phone-send --screenshot
```

The file appears in chat and may trigger a notification. This command works **only inside a Nanachi session**; it is not a global utility for any terminal.

The former automatic `phone-send` prompt hint and its `phoneSendHint` option have been removed. Enable the MCP explicitly in Settings if you want the agent to discover the sending tool.

### Memory and automatic learning

Open **Ajustes → Memória e aprendizado** (Settings → Memory and learning) on the selected PC. Learning starts disabled: enable it explicitly and choose which agents may participate. Existing Nanachi MCP opt-ins remain independent; the foreground agent needs both opt-ins to use `memory` and `skills`.

Memories and reusable procedures live in one global store in the daemon's SQLite database, with FTS5 search. All workspaces in the same Nanachi data folder share them; there is no workspace selector in memory management. Existing memories retain their IDs, versions, review history and source provenance when upgraded.

Every successful `memory`/`skills` tool call returns the current workspace's ID, name and path from the authenticated session, separately from each entry's source workspace. Neither the user nor the model needs to select a project. Project-specific facts retain their origin rather than becoming universal preferences. The foreground agent decides when to search, read, save or forget through MCP. Nanachi does **not** inject retrieved memories into its prompts, modify instruction files, or run a hidden review turn in the foreground conversation.

After the configured number of successful turns, an independent reviewer receives a bounded snapshot of the source work, its current workspace and relevant global knowledge with origin metadata. Its proposed changes must cite source-session evidence. A review that makes no changes stays silent. Confirmed changes produce one collapsed **Aprendizado atualizado** (Learning updated) line beside the source turn, not extra user/agent messages. Expand it to inspect entries or **Reverter aprendizado** (Revert learning). Reversal refuses to overwrite later edits.

The reviewer choices are:

| Selection | Behavior |
| --- | --- |
| **Mesmo modelo e conta da conversa** | Uses the original turn's model selector and account when that adapter supports isolated inference. Reusing the same model does not guarantee reuse of the prompt cache or lower billing. |
| **Agente e provedor configurados** | Select an advertised model from a compatible configured agent/provider. OMP uses its inference-only auth gateway; Claude Code uses its matched SDK with native tools, MCP, hooks and plugins disabled. |
| **OpenRouter** | Configure an API key and select from its model catalog, or supply an accepted model ID if catalog discovery is unavailable. |
| **Endpoint compatível com OpenAI** | Connect a local or remote chat-completions endpoint; for example, LM Studio at `http://127.0.0.1:1234/v1`. |
| **Ollama local** | Uses Ollama's native model discovery and chat API; the usual endpoint is `http://127.0.0.1:11434`. |

For a new endpoint, leave learning disabled, save the connection, choose **Atualizar modelos** (Refresh models), select a model, then enable learning. Use an address reachable by the PC, not by the phone. Remote endpoints require HTTPS; plaintext HTTP is limited to literal loopback or `localhost`. Redirects and credentials embedded in endpoint URLs are rejected.

The currently supported installed-agent review paths are OMP's `auth-gateway stdio` and Claude's inference-only SDK. Codex, Antigravity, terminal agents and unsupported command overrides are not offered as usable reviewer targets. An unsupported same-model selection produces an actionable quiet failure instead of executing tools or changing provider/account silently. Claude's unresolved `default` selector is not guessed: choose an explicit advertised model. Explicit family aliases are forwarded unchanged; the provider controls their underlying revision.

**Exigir aprovação antes de aplicar** (Require approval before applying) keeps proposals pending. Approve or reject them from the learning notice or the global memory list. **Memória global** (Global memory) loads automatically and supports search, inspection, editing and confirmed forgetting across all workspaces. Each entry shows its source project when available; manually created global entries and removed source projects are identified separately. Updates use versions so another device's later edit is not overwritten silently.

Forgetting excludes an entry from retrieval across all workspaces and suppresses relearning the same forgotten lesson elsewhere. It is not secure erasure: source conversations, local history and tombstones remain. Removing a workspace cancels its in-flight learning but does not delete global knowledge or its review history; retained entries remain manageable without selecting or recreating the source project. There is no automatic memory synchronization between PCs or separate Nanachi data folders.

Review frequency, input-character budget, output-token limit and timeout are configurable. Disabling learning, changing its configuration, cancelling/stopping the source session, deleting its workspace or shutting down the daemon cancels outstanding work before it can apply late changes. Already-issued provider requests may still incur charges.

**Privacy:** enabled agents and reviewers can access retained knowledge from other workspaces in this installation. Reviews can send conversation excerpts, workspace metadata and global knowledge to the configured model service. Recognizable secrets are filtered, but detection cannot guarantee removal of novel, unlabelled, split or encoded secrets. Choose a trusted local endpoint for sensitive work. Settings and the optional API key are stored in `<NANACHI_HOME>/learning.json`, outside the repository; the key is not returned to the PWA or stored in browser storage. Changing the provider destination clears an omitted old key rather than forwarding it to a different endpoint. Protect the daemon home and its backups; this file is not an encrypted secrets vault.


### Answer an agent's question

An agent with Nanachi MCP enabled can call `ask_user` with a question and two to eight options. It waits for your response without ending its turn. The **Pergunta do agente** (Agent question) card stays available even when older chat items are outside the visible history. Tap an option to send that exact choice, or **Cancelar pergunta** (Cancel question) to return no choice. The confirmed response remains in the chat history.

Closing the chat or briefly disconnecting the phone does not select an option: reopen the session to answer the pending question. Unanswered questions expire after five minutes; a tool client may cancel sooner. Cancelling or ending the turn, stopping the agent, losing its MCP connection, or restarting the daemon cancels outstanding questions. Old cards cannot approve anything after that.

If a response cannot be confirmed, the card keeps it unconfirmed. **Reenviar esta resposta** (Resend this response) explicitly retries the same choice. The server accepts only the first valid response, including when several paired devices are viewing the session.

These are conversation decisions, **not execution permissions**. YOLO never answers them. Question notifications follow the existing notification permissions, workspace mute setting, and rule that a device already viewing the chat receives no push for that session.

### Send a file requested by the agent

An enabled agent can call `request_file` with a plain-text request and optional accepted MIME types or extensions, such as `image/*` or `.pdf`. In the chat card, tap **Escolher arquivo** (Choose file), select one file, then **Enviar arquivo** (Send file). Choosing a file does not upload it automatically; cancelling the system picker leaves the request pending.

The daemon stores the attachment in Nanachi's data folder using the existing upload limits and session quotas. Only after your explicit response is confirmed does the waiting tool receive its absolute PC path. This does not submit another chat prompt or automatically copy the file into the project. The phone and request-history events receive file metadata, not that private path.

**Cancelar pedido** (Cancel request) returns no file. Requests expire after five minutes; MCP clients can cancel sooner. Closing the phone chat does not cancel a pending request, but ending the turn, stopping the agent, losing its MCP connection, or restarting the daemon does. If confirmation fails after an upload, **Tentar resposta novamente** (Try response again) retries the same uploaded file selection without uploading it again. A file with a different requested type cannot be sent through that card.

### Open a private project preview

An enabled agent can start an HTTP development server on IPv4 loopback and call `open_preview`, for example with `{ "port": 3000, "title": "Project preview", "path": "/" }`. The tool creates a chat card; it does **not** open a browser automatically. Tap **Abrir prévia** (Open preview) to view the application in another window. Allow pop-ups for Nanachi if the browser blocks it.

Preview HTTP and WebSocket traffic uses a separate origin from the Nanachi dashboard. This supports root-relative assets and development updates such as Vite HMR without exposing dashboard storage or forwarding Nanachi transport credentials to the project. A paired device receives a short-lived, single-use opening link; the preview itself lasts up to **30 minutes**. **Fechar prévia** (Close preview), stopping the agent, or restarting the daemon revokes access. Closing the preview does not stop the project's development server.

Creating or opening a preview probes the local HTTP server with a **3-second total deadline**, even if it keeps sending incomplete headers. Disconnecting the requesting client cancels that probe; stopping the session or daemon also cancels pending probes. Closing or expiring a preview cancels any pending opening. Cancelled creation attempts release their reserved preview quota and do not publish a card.

**Transport setup:**

- **Desktop with Tailscale embutido enabled:** the sidecar serves private preview HTTPS on port **8443**, separately from the dashboard on 443. No additional Serve command is needed.
- **Manual Tailscale Serve:** keep the existing dashboard mapping and add the preview mapping below. This example assumes the daemon's default port 7777; its loopback preview gateway uses 7778. If you change the daemon port, use the next port for this target (65535 uses 65534).

  ```powershell
  tailscale serve --bg --https=8443 http://127.0.0.1:7778
  tailscale serve status
  ```

Use **Serve, not Funnel**. Both devices still need private tailnet access; if your tailnet policy restricts destination ports, preview access also needs 8443 for the intended peers. Do not forward router ports. No TURN server or Coturn installation is needed. Local PC testing uses the separate HTTP loopback gateway instead of tailnet HTTPS.

**Preview boundaries:** one preview is active per browser profile and PC. Opening another changes the target of all that PC's preview tabs in the same profile. Projects share this preview origin, not the dashboard origin. The gateway blocks service-worker requests and forces `Cache-Control: no-store` on project responses, overriding upstream caching and rejecting unsolicited 304 responses. Scripts, pages and API responses are fetched again rather than reused from the HTTP cache. Dedicated workers, the project's own CSP and HMR WebSockets remain supported. The gateway does not forward `Authorization` or Nanachi/Tailscale identity headers; applications that depend on those headers need a different development authentication flow. Hard-coded `localhost` URLs and custom HMR hosts in a project may need adjustment to work from the phone.

**If you used previews before this hardening:** close existing preview tabs and clear cached content and service-worker/site storage for the **preview origin** before opening another preview. This is the address on HTTPS port 8443 (or the adjacent loopback port), not the Nanachi dashboard origin. The new response headers cannot remove previously cached responses or an already controlling service worker. Clearing preview data can reset project-local state; a clean browser profile is an alternative.

### Git and terminal

In a Git workspace, open **More session actions (Mais ações da sessão)** (the "…" button in the chat header), then **Commit history (Histórico de commits)**. It lists the commits of the session's branch, newest first, one page at a time. Tap a commit to see its files and their patches. The first row, **Working tree (Árvore de trabalho)**, opens the uncommitted changes in the **Changes (Alterações)** screen: modified and untracked files, each with its patch. That row is hidden in a folder that is not a Git repository.

To isolate a task, select **In a separate worktree (Em worktree separado)** when creating the session: it gets its own checkout and branch.

When ending a session, the app can remove the worktree. If it contains uncommitted changes, removal is refused to preserve your work; the branch is deleted only if it has already been merged.

Terminal sessions, such as the workspace shell or a custom agent with `kind: "pty"` in `config.json`, show the terminal with a line field below it, on phones and PCs alike. Type a line and tap **Enviar** (Send) to send it with Enter. There is no key bar, so keys such as Ctrl+C are not offered on the phone's screen.

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

1. In a session, tap **More session actions (Mais ações da sessão)** (the "…" button in the chat header), then **Agent usage (Uso do agente)**.
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

Push notifications use the same language. The phone sends it when notifications are turned on, and again when you change the language while they are on. Subscriptions made by older versions of the app get Portuguese until the phone sends its language.

Not translated:

- Text that agents and the daemon send, such as agent output, session titles, their error messages, login output, and the lines Oh My Pi prints for resets.
- Command names such as `/model`.

### Dictate a chat message

Open **Ajustes → Ditado por voz** (Settings → Voice dictation) on your phone, or **Ajustes → Transcrição de voz** (Settings → Voice transcription) in Nanachi Desktop. On the phone, these settings apply to the selected PC.

Choose the transcription source and model, then save:

- **Whisper local (padrão):** the existing local `ggml-base-q5_1.bin` model remains the default. Turn on the separate local Whisper installation switch to download about 68 MB to that Windows PC. The microphone appears after installation finishes. Audio stays on that PC.
- **OpenAI:** speech-transcription models, including GPT Transcribe; legacy models are marked deprecated. Requires an API key and may incur API charges. See the [OpenAI speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text).
- **Groq:** Whisper Large V3 Turbo or Whisper Large V3 with a Groq API key. Audio goes to Groq and may incur charges. See the [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text).
- **API própria de transcrição / Endpoint próprio:** a local or remote speech model served through an OpenAI-compatible transcription API. Enter its base URL, exact model ID and optional key. For example, `http://127.0.0.1:8000/v1` refers to a server on the **PC**, not the phone. Nanachi sends multipart WAV requests to `/audio/transcriptions` and expects JSON with a `text` field. A chat-only endpoint or model is not sufficient.

For your own API, you can save the connection first and discover its models, or enter a model ID manually. Discovery only lists models explicitly identified as speech/transcription-capable, plus the saved manual selection. An unannotated chat catalog is not treated as a speech-model catalog. Select and save a model before dictating. Remote URLs require HTTPS; HTTP is limited to `localhost` and literal loopback addresses. Do not put credentials, query parameters or fragments in the base URL.

API keys are stored in the PC's Nanachi data folder, not browser storage. Settings return only whether a key exists. Leave the key field blank to keep it for the same destination; changing the provider or base URL clears the old key unless you explicitly provide a replacement.

Tap the microphone, speak, and stop the recording. Nanachi transcribes up to 60 seconds at a time in the app's current language and appends the result to the existing draft. Review the text, then tap **Enviar** (Send). Dictation never sends a chat message automatically. Cancel discards the recording; cancelling an upload cannot guarantee that a remote provider has not already processed or charged for it.

Only the saved source receives new recordings; Nanachi never silently falls back to another provider. Remote transcription works without installing local Whisper. Changing providers does not install or remove Whisper. Nanachi discards its temporary recording after transcription, but remote providers' retention policies still apply.

To remove Nanachi's local Whisper engine and model, turn off its separate installation switch and choose **Desativar e remover** (Turn off and remove).

## Keep it ready when you need it

With Desktop, leave Nanachi running in the tray and use **Iniciar com o Windows** (Start with Windows) if you want it to launch when you sign in. Closing its control-center window does not quit it. The launcher and supervisor below are **for a source checkout**, not prerequisites for the installed Desktop app; do not run them against Desktop's data folder.


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

Nanachi Desktop 1.0.1 is the Windows x64 installer path described in [Get started on your PC](#get-started-on-your-pc). It bundles the daemon, mobile web app, Node.js runtime and optional Tailscale sidecar, with a tray icon and local control center. Agent setup and Git-dependent features still have their own prerequisites. The installer is unsigned; see [Desktop limits](#desktop-limits).

### What it does

- **Runs the daemon** with its own bundled Node.js and restarts it after a crash (it stops retrying after more than 5 crashes in 2 minutes and shows an error). It has its own data folder, `%USERPROFILE%\.nanachi-desktop` (set `NANACHI_DESKTOP_HOME` to move it), separate from a standalone daemon or the supervisor, which keep using `%USERPROFILE%\.nanachi-remote`. Desktop never reads `NANACHI_HOME`, so sessions, paired devices and `config.json` are not shared with them. On a fresh folder it writes `config.json` with `"port": 7780` (an existing `config.json` is never rewritten, and its port wins), so Desktop and a standalone daemon on 7777 run side by side. The daemon's log is `desktop-daemon.log` in that folder.
- **Attaches to a daemon that is already running.** If a Nanachi daemon already answers on Desktop's port (another copy of Desktop, for example; not the supervisor on 7777 unless you point Desktop's `config.json` at it), Desktop starts nothing, shows "conectado ao daemon existente" (connected to the existing daemon), and never stops that daemon when you quit.
- **Tray icon.** The first menu line is the status: `Nanachi · rodando` (running), `· iniciando` (starting), `· conectado ao daemon existente`, `· parado` (stopped), or `· erro` (error). The items are **Abrir Nanachi** (open the control center), **Abrir sessões** (open the control center on its **Sessões** section), **Gerar código de pareamento** (generate a six-digit code and a QR when a private Tailscale address is available), **Iniciar com o Windows** (start in the tray when you sign in), and **Sair** (quit). Quitting stops the daemon only if Desktop started it.
- **Control center.** The main window is a desktop control panel for this PC, with its own title bar and a sidebar: **Visão geral** (overview: daemon, built-in Tailscale, activity), **Pastas e discos** (folders and drives), **Aparelhos** (paired devices and pairing codes), **Contas dos agentes** (agent accounts), **Tailscale**, **Diagnóstico** (diagnostics), **Logs**, **Ajustes** (settings: language, start with Windows, updates, uninstall), and **Sessões** (the sessions and chat, below). Ctrl+1 to Ctrl+8 switch sections (**Diagnóstico** has no shortcut), and Ctrl+B collapses the sidebar (on **Sessões** it is always the narrow icon rail, whatever you saved). The window cannot be made smaller than 980 x 620. Closing the window keeps Desktop running in the tray.
- **Folders and drives.** **Pastas e discos** edits `allowedRoots` in Desktop's `config.json`: pick folders with the Windows folder picker or allow a whole drive. Saving restarts Desktop's own daemon; every session comes back stopped and resumes on its next message, and the app asks first when sessions are busy. Only the PC can change this list; the phone only reads it. It chooses where sessions can open; it is not a sandbox.
- **Diagnostics and logs.** **Diagnóstico** shows the daemon, Tailscale, the port, and the last sync on one page. **Copiar relatório** (Copy report) copies a plain English text report with the daemon and Tailscale state, activity counts, and up to 20 of the newest daemon log lines. The report redacts tokens, pairing codes, push subscription keys, e-mail addresses, and your Windows user name; the log lines on the page are redacted the same way. The tailnet name and IP addresses are kept on purpose, so check the report before you share it. **Logs** highlights timestamps, levels, strings, and paths. Unsaved changes in **Pastas e discos** stay when you switch sections, and the sidebar marks them with a dot.
- **Sessions.** The **Sessões** section (Ctrl+8; the **Abrir sessões** buttons and the tray item go there) shows this same web app, loaded from the local daemon, inside the control center window, for the sessions and chat, with an extra **Desktop** group in its Settings. While the daemon is starting, stopped, failed, or only accepts Tailscale, the section explains that instead. The web app there is in its wide layout (a list of workspaces and sessions beside the screen), because the window cannot get smaller than that layout needs. There is no separate sessions window. If the web app's page keeps closing (twice within 30 seconds), the section says so and tries again when you open it again. On first run Desktop registers itself as a device named "Nanachi Desktop (PC name)", shown as **Este app** in **Aparelhos**.
- **Languages.** Português (Brasil), English and Español. On its first run Desktop takes the language of Windows (anything other than Spanish or Portuguese becomes English); change it in **Ajustes → Idioma**. The control center, the tray menu, Desktop's messages and the web app inside **Sessões** switch at once. The web app switches live, without reloading, and keeps a language you later choose inside it until Desktop's own language changes again. A Desktop installed before the languages existed stays in Português (Brasil) until you change it. The installer speaks the language the installed Desktop is set to (the Windows language on a first install); the uninstaller uses the language Desktop saved.

### Build it

This section is for **building Desktop from source**, not installing the release. Start with a clone of this repository and its npm dependencies. You need Windows x64, **Node.js 22** (the packaging script refuses other major versions, because it bundles a copy of that Node), and Go for the Tailscale sidecar. `packages/desktop/tsnet/go.mod` requires Go 1.27.3. Install a current Go: unless `GOTOOLCHAIN` is set to `local`, the `go` command downloads the required toolchain on first use.

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

The installed runtime includes this README and the original-code MIT `LICENSE`; the README explains the separate artwork, name and third-party licensing scope.

The root `npm run build` does not build Desktop, so a Desktop build problem cannot stop the supervisor.

### Install and uninstall

Run `Nanachi-Setup-1.0.1.exe` for this release (`Nanachi-Setup-<version>.exe` for other versions). It opens its own window instead of a Windows wizard: **Instalar** (Install), a progress bar, then **Abrir o Nanachi** (Open Nanachi). **Opções** (Options) changes the install folder, the desktop shortcut, and start with Windows; the last two are on by default. If Nanachi Desktop is running, the installer asks to close it.

The install is per user and does not ask for administrator rights. The default folder is `%LOCALAPPDATA%\Programs\Nanachi`. It creates a Start Menu shortcut, a desktop shortcut unless you turn that off, and an uninstall entry for your user.

To uninstall, remove **Nanachi** in Windows **Settings → Apps**, or run `Nanachi.exe --uninstall` from the install folder. A confirmation window opens and stops the daemon Desktop owns. Desktop's data folder (`%USERPROFILE%\.nanachi-desktop`: sessions, devices, `config.json`) is kept unless you tick **Apagar também os dados do Nanachi** (also delete Nanachi's data), which deletes only that folder and Desktop's own profile. It always refuses the standalone daemon's folder, `%USERPROFILE%\.nanachi-remote`, and the folder named by `NANACHI_HOME` when that is set.

### Built-in Tailscale

Open Desktop's **Tailscale** sidebar section and turn on **Tailscale embutido** (Built-in Tailscale). This starts a small sidecar (`nanachi-tsnet`, built on Tailscale's `tsnet`) that serves the daemon over private HTTPS. It is off by default; the mobile web app's **Ajustes → Desktop** group also exposes Desktop controls.

1. Turn it on and use **Entrar no Tailscale** (sign in to Tailscale) to approve this PC. It joins your tailnet as a separate device named `nanachi-<PC name>`. The Tailscale app installed on Windows, `tailscale serve`, and Funnel are not touched.
2. When it connects, the panel shows **Endereço para o dispositivo móvel** (Address for your mobile device), an `https://` address on your tailnet.
3. On your phone, install Tailscale, connect to the same tailnet, then follow the [Android or iPhone installation steps](#install-on-your-phone). Generate a code or QR under **Aparelhos → Parear novo aparelho** or from **Gerar código de pareamento** in the tray.

The tailnet needs **MagicDNS** and **HTTPS Certificates** enabled, the same as for `tailscale serve`. If your tailnet requires device approval, approve the new device in the Tailscale admin console. The sidecar sends the same identity headers as `tailscale serve`, so `allowedTailscaleLogins` still applies to phones that connect through it. You do not need the built-in node if you already use Serve; make sure Serve targets **Desktop's configured port**, not another daemon.

### Updates

On start, Desktop asks GitHub for the latest release of this repository (without a token). You can also check under **Ajustes → Atualizações → Verificar atualizações** (Settings → Updates → Check for updates). If a newer release has a `Nanachi-Setup-*.exe` asset, Desktop offers **Baixar** (Download) to open the release page. **Updates are manual:** Desktop never downloads or installs an update by itself. Download the newer installer from that release page and run it.

### Desktop limits

- **Not code-signed.** Windows may show SmartScreen or unknown-publisher warnings. A version number is not a security certification.
- **Large download and installation.** Desktop includes Electron, Node.js and native agent integration binaries. Use the actual asset size on the release page rather than assuming the size of an earlier local build.
- **Windows x64 only.**
- **Support logs stay in Portuguese.** `desktop-daemon.log` and the installer log are written in Portuguese, for support; everything you read in a window, the tray, or a dialog follows [Desktop's language](#nanachi-desktop).
- **The local panel needs an empty `allowedTailscaleLogins`.** With that list set, the daemon refuses requests that carry no Tailscale identity, and the panel comes from `127.0.0.1`, so it shows an explanation page instead of the app. Desktop's own `config.json` (in `.nanachi-desktop`) has no allowlist unless you add one, and the daemon's authentication is unchanged. An empty list accepts any tailnet login that Tailscale forwards, but a device token is still required. Read [Security](#security-without-the-fine-print) before relying on that, and keep the list empty only in Desktop's folder.
- **Not validated on a clean Windows installation or physical Android/iPhone devices.** Automated tests and smoke scripts use controlled environments, temporary data and test doubles where applicable; browser phone viewports are not physical-phone evidence. Clean-machine installation, SmartScreen behavior, real-phone Tailscale login/HTTPS/push, and launch after a Windows reboot remain unverified. Version 1.0.1 does not remove these limitations.

## More than one PC

Each PC has its own daemon and data. Install the web app once, then add your other machines to it.

1. Repeat the [Desktop setup](#get-started-on-your-pc) or [standalone setup](#from-source-standalone-daemon) on the second PC, including private Tailscale access.
2. In **the second PC's** `config.json`, authorize the HTTPS origin from which you installed the app:

   ```json
   "corsOrigins": ["https://main-pc.my-tailnet.ts.net"]
   ```

3. Restart the second daemon, generate a code on that PC, and tap **Pair machine (Parear máquina)** on your phone. Use the second PC's HTTPS address and its code.
4. For notifications from all PCs, copy `vapid.json` from the main PC's Nanachi data folder to the data folder used by each other PC, **before starting the destination daemons and enabling notifications**. Desktop uses `.nanachi-desktop`; standalone uses `.nanachi-remote` by default. If they are already running, stop them first and restart them afterward. All machines need the same key. Re-enable notifications in the app if they were already configured.

**`vapid.json` contains a private key.** Transfer it only between your own PCs through a secure channel, and never commit it.

## Security, without the fine print

Nanachi lets you control processes running as **your Windows user**. Treat a paired phone as a key to your PC.

- The daemon listens only on loopback; remote access goes through **Tailscale Serve or Desktop's built-in Tailscale node**, not a public listener.
- Restrict access with your tailnet's rules. For a standalone daemon, set `allowedTailscaleLogins` too. Desktop's local panel currently requires that list to stay empty; this accepts any tailnet identity that can reach it, so read [Desktop limits](#desktop-limits) and restrict the node's reachability instead of treating pairing as your only boundary.
- Each device receives its own token. The database stores its hash, not the original token. Pairing codes expire after 5 minutes and have an attempt limit.
- **`allowedRoots` does not isolate the agent.** It can access other folders with your user's permissions. Use the agent's approval modes, especially with third-party projects.
- Lost your phone? Revoke it under **Settings → Devices on this machine (Ajustes → Dispositivos desta máquina)** or through the CLI below. Revocation closes the connection. A device that stays unused for `deviceInactivityDays` (90 days by default) stops working on its own.
- Do not publish `config.json` with personal data, `data.db`, `vapid.json`, tokens, attachments, or logs from your data folder. The `accounts` folder there holds the credentials of extra [agent accounts](#agent-accounts).
- Local storage is not the same as local inference. Agent prompts, attachments, learning reviews and voice recordings may go to the providers you configure. MCP and learning start opt-in; inspect their settings and provider policies before using sensitive projects. See [memory privacy](#memory-and-automatic-learning) and [voice transcription](#dictate-a-chat-message).
- Do not use Funnel or expose the daemon's port to the internet.

<details>
<summary><strong>Protection details and limits</strong></summary>

The daemon validates Host and Origin, restricts additional origins through `corsOrigins`, and checks the login forwarded by Tailscale. The `/api/agent/*` routes used by `phone-send` reject proxied requests. Agent tokens are session-specific, exist only in memory, and become invalid when the daemon stops.

Each session allows up to **200 files and 500 MiB**, counting both directions. File notifications have a minimum interval of 60 seconds per session. PNG, JPEG, GIF, and WebP can appear inline; other downloads are sent as `application/octet-stream`.

The push service accepts only HTTPS endpoints from the providers allowed by the daemon (FCM, Mozilla, WNS, and Apple). Expired subscriptions returning 404 or 410 are removed.

</details>

## Useful commands

These commands are for a **source checkout and standalone daemon**. Run them from the repository root; startup commands use the output of `npm run build`. They target `.nanachi-remote` by default, not Desktop's data. For an installed Desktop app, use its control center and tray instead.

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

For the standalone daemon, the default data folder is `%USERPROFILE%\.nanachi-remote`. To use another location, set `NANACHI_HOME` in the environment of **every** daemon and CLI command. Desktop instead uses `%USERPROFILE%\.nanachi-desktop` (or `NANACHI_DESKTOP_HOME`), ignores `NANACHI_HOME`, and creates fresh configurations on port **7780**; the defaults below describe standalone use.

| Field | Default | Purpose |
| --- | --- | --- |
| `port` | `7777` | Local port; also update the Tailscale Serve target if you change it. |
| `host` | `127.0.0.1` | Accepts only `127.0.0.1`, `::1`, or `localhost`. |
| `machineName` | PC name | Name displayed in the app. |
| `allowedRoots` | `[]` | Roots available when choosing workspaces. |
| `allowedTailscaleLogins` | `[]` | Authorized logins; an empty list accepts any login forwarded by Serve. |
| `corsOrigins` | `[]` | Additional origins, such as the main PC's origin in a multi-machine setup. |
| `reloadQuietMs` | `60000` | Quiet period without new builds before the supervisor reloads. |
| `deviceInactivityDays` | `90` | Days without use after which a paired device stops working: its token gets `401` with `device_expired`, and the device is listed as expired. Any use renews the period. `0` turns the limit off. |
| `agents` | omp, claude, codex, agy | Agent map with `label`, `command`, `args`, `env`, and `kind` (`acp` or `pty`). |

An entry in `agents` overrides the default for the same ID. Default agents not defined in the file remain available in memory. Restart the daemon after editing the configuration.

An `agy` entry that is exactly the terminal default earlier versions wrote into the file (`label` `Antigravity`, `command` `agy`, `kind` `"pty"`, no arguments or environment variables) is treated as not set, so the ACP default applies and the file is not changed. Any other `agy` entry is kept as written.

</details>

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| The address does not open on your phone | PC powered on, Nanachi running, Tailscale connected on both devices, tailnet access rules, and the HTTPS address from Desktop's **Tailscale** section or `tailscale serve status`. |
| No folder appears when creating a workspace | In Desktop, add folders under **Pastas e discos** and save. For standalone, add existing folders to `allowedRoots` and restart the daemon. |
| Invalid or expired code | Generate another in Desktop's **Aparelhos** section/tray, or with `npm run pair -w @nanachi/daemon` for standalone; each code works once and lasts 5 minutes. |
| Android only creates a shortcut | Use up-to-date Chrome, HTTPS, and a normal tab. Look for **Install app** or **Add to Home screen → Install**. |
| Notifications do not arrive | Check system/browser permissions, an active Tailscale connection, and the same VAPID key across PCs. On iPhone, use iOS 16.4+ and open the installed icon. |
| Notifications stopped working | Enable them again in **Settings (Ajustes)**; the subscription may have expired. On Android, also check battery restrictions. |
| WebSocket does not connect | Make sure the proxy forwards origin headers. If needed, add the app's HTTPS origin to `corsOrigins` and restart. |
| The agent does not start | Try its command in the terminal and check PATH and login. Install `omp` and `agy` separately. |
| Antigravity asks for login or folder trust | Open `agy` once on your PC and answer its prompts in the desired folder. |
| Screenshots are black | Run the daemon in your user's desktop session. A Windows service cannot see the same desktop. |
| Port 7777 or 7780 is in use | Standalone defaults to 7777; Desktop defaults to 7780. Do not run a manual daemon and supervisor on the same port. If you change `port`, update manual Tailscale Serve mappings too. |
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

## License

Everward Research licenses the original Nanachi Remote source code and accompanying documentation under the [MIT License](LICENSE). Project names, logos, artwork, and the separate Everward Cloud backend are outside its scope. Third-party dependencies and materials retain their respective licenses and terms.

---

Built to follow your work from anywhere without handing control of your PC to a public dashboard. Start with one machine, one project, and one agent; add the rest when you need it.
