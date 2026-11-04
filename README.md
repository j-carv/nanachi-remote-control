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

  <p><sub><em>Disclaimer: Nanachi is a character from <strong>Made in Abyss</strong>, created by Akihito Tsukushi and published by Takeshobo; the anime adaptation is produced by Kinema Citrus. All rights to the character and the series belong to their respective owners. This is an unofficial fan-named personal project with no affiliation with, or endorsement by, the author, the publisher, or the studio.</em></sub></p>

  <p><a href="#get-started-on-your-pc">Setup</a> · <a href="#install-on-your-phone">Android and iPhone</a> · <a href="#everyday-use">How to use it</a> · <a href="#troubleshooting">Help</a></p>
</div>

---

## The idea

Leave an agent working on Windows and continue the conversation from your phone. Nanachi is the bridge: it organizes projects and sessions, displays chat and terminal output, accepts attachments, and lets you know when you are needed.

Your own PC serves the dashboard inside your Tailscale network. **There is no need to host a cloud backend, forward router ports, or use WSL.** Agents still use their own AI services and accounts—Nanachi does not replace those accounts or make the models run locally.

> Your PC must be powered on, connected to Tailscale, and running the daemon. Your phone is the remote control, not where the agent runs.

### What you can do

- **Chat with agents** with real-time responses, Markdown, code, and tool details.
- **Choose model, access, and effort settings** when the agent supports them, and respond to permission requests in chat.
- **Use `/` commands** advertised by the agent, with search built into the message field.
- **Resume PC sessions** when the agent supports listing and reopening its history.
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

The app's interface currently uses Portuguese labels. The instructions below give their English meanings and preserve the labels you need to find.

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

## Keep it ready when you need it

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
- Do not publish `config.json` with personal data, `data.db`, `vapid.json`, tokens, attachments, or logs from your data folder.
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
| Error reading `config.json` | Check for valid JSON and inspect the field named in the message. PowerShell 5.1's UTF-8 BOM is accepted. |

## Working on the code

This is an npm workspaces monorepo:

```text
packages/
  shared/   Protocol types and Zod schemas
  daemon/   Fastify API, WebSocket, SQLite, agents, and CLI
  pwa/      React, Vite, service worker, and mobile interface
e2e/        End-to-end scenarios with Playwright and Edge
docs/       Technical contracts and project notes
```

```powershell
npm install
npm run build
npm test
npm run typecheck
```

For integrated reloading, use `npm run supervise`. You can also use `npm run dev -w @nanachi/daemon` and `npm run dev -w @nanachi/pwa` to work on individual packages; build `shared` first. Vite proxies `/api` and `/ws` to `127.0.0.1:7777`. Check installation and notifications with the **built PWA served over HTTPS**, not just the development server.

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

More details: [contracts and architecture (Portuguese)](docs/PLAN.md) · [manual configuration (Portuguese)](docs/PENDENTES-USUARIO.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. External contributors should fork the repository and open a pull request for review by **@j-carv**. The repository is public, but public visibility does not grant write or merge access.

---

Built to follow your work from anywhere without handing control of your PC to a public dashboard. Start with one machine, one project, and one agent; add the rest when you need it.
