# Nanachi Remote — Plano de implementação

Fonte: doc "Plano: app iOS para controlar agentes de IA no Mac" (claude.ai/artifact/W6vAaWyGxAubSWZENoDp95).
Resumo: PWA no iPhone ↔ daemon Node/TS em cada PC Windows ↔ agentes (omp, Claude Code, Codex, agy) via ACP.
Rede: Tailscale (`tailscale serve https / http://localhost:7777`). Tudo nativo no Windows, sem WSL.

## Regras para quem implementa

- TypeScript strict, sem `any`. ESM. Node 22.
- TDD: escreva o teste (vitest) antes do código quando aplicável. `npm test` precisa passar no fim.
- YAGNI: implemente só o que a tarefa pede. Não antecipe fases futuras.
- Bibliotecas consolidadas: fastify, @fastify/websocket, @fastify/static, @fastify/cors, better-sqlite3, zod, vitest, react, vite, vite-plugin-pwa.
- Antes de usar uma API de biblioteca que você não conhece bem, leia os `.d.ts` em `node_modules`.
- Não rode `git commit`. Não instale nada global. Não toque fora da pasta do projeto, exceto `~/.nanachi-remote/` em testes manuais.

## Estrutura (npm workspaces)

```
package.json            workspaces: packages/*
tsconfig.base.json      strict, module NodeNext/ESNext, target ES2022
packages/shared         tipos e schemas zod do protocolo (importado por daemon e pwa)
packages/daemon         Fastify + WS + SQLite + CLI (pair, devices, revoke)
packages/pwa            React + Vite + vite-plugin-pwa
```

## Contrato (Fase 0)

### Config do daemon
`%USERPROFILE%\.nanachi-remote\config.json` (criado com defaults se não existir; dir sobrescrevível por env `NANACHI_HOME` — usado nos testes):
```json
{
  "port": 7777,
  "host": "127.0.0.1",
  "machineName": "<hostname>",
  "allowedRoots": [],
  "allowedTailscaleLogins": [],
  "corsOrigins": []
}
```
Validado com zod (`ConfigSchema` em shared). DB: `<NANACHI_HOME>/data.db`.

### SQLite (Fase 0)
- `machine(id TEXT PK, name TEXT)` — uma linha; id = uuid gerado na 1ª execução.
- `devices(id TEXT PK, name TEXT, token_hash TEXT UNIQUE, created_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER NULL)` — token guardado só como sha256.
- `pair_codes(code TEXT PK, expires_at INTEGER, used_at INTEGER NULL)`.
Migrações versionadas simples (`PRAGMA user_version`).

### Pareamento (sem superfície admin HTTP)
- `npm run pair -w @nanachi/daemon` → CLI escreve um código de 6 dígitos em `pair_codes` (expira em 5 min) e imprime.
- `npm run devices -w @nanachi/daemon` lista; `npm run revoke -w @nanachi/daemon -- <id>` revoga.

### HTTP
Todas as rotas `/api/*` passam pela checagem Tailscale: se `allowedTailscaleLogins` não for vazio, o header `Tailscale-User-Login` precisa estar na lista, senão 403.
- `GET /api/health` (sem token) → `{ ok: true, machineId, machineName, version }`
- `POST /api/pair` (sem token) body `{ code, deviceName }` → `{ token, deviceId, machineId, machineName }`; código inválido/expirado/usado → 401. Rate limit simples: 5 tentativas erradas/min → 429.
- Demais rotas: `Authorization: Bearer <token>`; token revogado/inexistente → 401. Atualiza `last_seen_at`.
- `GET /api/me` → `{ deviceId, deviceName, machineId, machineName }`
- CORS: só origens em `corsOrigins`.
- Fora de `/api` e `/ws`: serve `packages/pwa/dist` estático, com fallback SPA para `index.html`.

### WebSocket `/ws?token=<token>`
Mensagens JSON validadas por zod (`ClientMessage`/`ServerMessage` em shared, união discriminada por `type`).
- Token inválido → fecha com code 4401.
- Servidor envia ao conectar: `{ type: "hello", machineId, machineName }`.
- Cliente `{ type: "ping" }` → servidor `{ type: "pong" }`.

### PWA (Fase 0)
- Manifest (nome "Nanachi Remote", display standalone, ícones 192/512), service worker com cache do app shell (vite-plugin-pwa, `registerType: 'autoUpdate'`).
- Lista de máquinas em `localStorage` (`nanachi.machines`): `{ id, name, baseUrl, token }[]`.
- Tela de pareamento: `baseUrl` (default `location.origin`), código, nome do dispositivo → `POST {baseUrl}/api/pair` → salva máquina.
- Tela principal: seletor de máquina; status online/offline (WS conectado + `hello` recebido; reconecta com backoff).
- Layout mobile-first, safe-area do iPhone, tema escuro.

**Pronto quando:** o ícone abre no iPhone pelo 4G e mostra o PC online.

## Contrato (Fase 1 — MVP com Oh My Pi)

### ACP
- SDK `@agentclientprotocol/sdk@^2.4` (import padrão = ACP v1 estável). A API nova é `client({ name })` → `.onRequest(...)` / `.onNotification(...)` → `.connect(stream)` (conexão longa, retorna `ClientConnection` com `.agent: ClientContext`) ou `.connectWith(stream, async ctx => ...)`. Stream: `ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))`. Constantes de método em `methods`. **Leia `node_modules/@agentclientprotocol/sdk/dist/v1/acp.d.ts` e `dist/v1/schema/types.gen.d.ts` antes de codar.** Não use a API antiga `ClientSideConnection` se ela não existir.
- Fluxo por sessão: spawn do comando do agente (`cwd` = pasta do workspace, `windowsHide: true`, `shell: false`; no Windows resolva `.cmd`/`.exe` pelo PATH) → `initialize` (protocolVersion do SDK; clientCapabilities sem fs e sem terminal) → `session/new { cwd, mcpServers: [] }` → `session/prompt` por mensagem → notificações `session/update` → requests `session/request_permission` (resposta `{ outcome: { outcome: "selected", optionId } }` ou `{ outcome: { outcome: "cancelled" } }`) → `session/cancel` (notificação) para interromper.
- Observado com `omp acp` 18.13.2 real (03/11): `spawn('omp', ['acp'])` sem shell funciona; `initialize` devolve `loadSession: true`; `tool_call` vem com `kind`, `status: "pending"`, `rawInput`, `locations: [{ path }]`; o `content` dos tool calls vem como `{ type: "content", content: { type: "text", text } }` (mapear para `ToolContent` text) ou `{ type: "diff", path, oldText, newText }`; `session/prompt` resolve com `{ stopReason: "end_turn" }`. O omp desta máquina auto-aprova escrita de arquivo, mas PEDE permissão para comandos de shell (visto na Fase 3); então o fluxo de permissão deve ser testado com um agente ACP falso (`test/fixtures/fake-agent.ts`, feito com `agent()` do próprio SDK, que ecoa o prompt em chunks, emite um tool_call com diff e, se o prompt contiver "permission", chama `session/request_permission`).
- Um processo de agente por sessão. Ao parar a sessão ou desligar o daemon, mata o processo (árvore inteira no Windows: `taskkill /pid <pid> /T /F`).

### Config (acréscimo)
```json
"agents": { "omp": { "label": "Oh My Pi", "command": "omp", "args": ["acp"], "env": {} } }
```
Esse é o default. `AgentConfigSchema = { label, command, args: string[] = [], env: Record<string,string> = {} }`.

### SQLite (acréscimo, migração 2)
- `workspaces(id TEXT PK, name TEXT, path TEXT UNIQUE, created_at INTEGER)`
- `sessions(id TEXT PK, workspace_id TEXT, agent TEXT, title TEXT, status TEXT, acp_session_id TEXT NULL, created_at INTEGER, updated_at INTEGER)`
- `events(seq INTEGER PK AUTOINCREMENT, session_id TEXT, ts INTEGER, kind TEXT, payload TEXT)` + índice `(session_id, seq)`.
Ao iniciar o daemon, sessões que não estão `stopped`/`error` viram `stopped` (retomar é Fase 2).

### Pastas permitidas
Função pura `resolveInsideRoots(input, roots)`: `fs.realpathSync.native` no alvo e nas raízes; compara case-insensitive no win32 com separador normalizado; aceita a própria raiz e descendentes; recusa `..`, links e junctions que escapem. Erro → 403 `{ error: "outside_roots" }`; inexistente → 404.

### HTTP (Bearer)
- `GET /api/roots` → `{ roots: { path, name }[] }`
- `GET /api/fs?path=<abs>` → `{ path, parent: string|null (null na raiz permitida), dirs: { name, path }[] }` (só diretórios, ordenados, sem ocultos/`node_modules`/`.git`).
- `GET /api/agents` → `{ agents: { id, label }[] }`
- `GET /api/workspaces` → `{ workspaces: Workspace[] }`; `POST /api/workspaces { path, name? }` → `Workspace` (path validado; nome default = basename; duplicado → devolve o existente); `DELETE /api/workspaces/:id` (para as sessões dele).
- `GET /api/workspaces/:id/sessions` → `{ sessions: Session[] }` (mais recente primeiro)
- `POST /api/sessions { workspaceId, agent }` → `Session` (sobe o agente; status `starting` → `idle`, ou `error` com evento de erro)
- `DELETE /api/sessions/:id` → para o processo, status `stopped`.
- `GET /api/sessions/:id/events?after=<seq>&limit=<n≤500>` → `{ events: SessionEvent[] }`
`Workspace = { id, name, path, createdAt }`. `Session = { id, workspaceId, agent, title, status, createdAt, updatedAt }`, `status ∈ starting|idle|running|awaiting_permission|stopped|error`. Título = primeiros 60 chars do primeiro prompt (antes disso, "Nova sessão").

### Eventos de sessão (gravados em `events`, enviados pelo WS)
`SessionEvent = { seq, sessionId, ts } & (um destes, discriminado por kind)`:
- `user_message { text }`
- `agent_message_chunk { text }` / `agent_thought_chunk { text }`
- `tool_call { toolCallId, title, toolKind?, status?, content: ToolContent[], locations: string[] }`
- `tool_call_update { toolCallId, title?, status?, content?: ToolContent[] }`
- `plan { entries: { content, status, priority }[] }`
- `permission_request { requestId, title, toolKind?, rawInput?: unknown, content: ToolContent[], options: { optionId, name, kind }[] }`
- `permission_resolved { requestId, optionId: string|null }`
- `turn_end { stopReason }`
- `status { status }`
- `error { message }`
`ToolContent = { type: "text", text } | { type: "diff", path, oldText: string|null, newText }`. Outros `sessionUpdate` do ACP são ignorados (log debug).

### WebSocket (acréscimo)
Cliente → servidor:
- `subscribe { sessionId, afterSeq }` → servidor manda todos os eventos com `seq > afterSeq` (em ordem) e depois os novos ao vivo.
- `unsubscribe { sessionId }`
- `prompt { sessionId, text }` (recusa com `error` se status ≠ idle)
- `permission_response { sessionId, requestId, optionId: string|null }` (null = cancelar)
- `cancel { sessionId }`
Servidor → cliente: `event { event: SessionEvent }`, `session { session: Session }` (broadcast a todos os clientes autenticados quando status/título mudam), `error { message, sessionId? }`.

### Opções de sessão: modelo, effort, nível de acesso (pedido do usuário em 03/11)
Genérico via ACP `configOptions`, sem nada específico de agente. Observado:
- omp: `mode` (cat. `mode`: default/plan), `model` (cat. `model`), `thinking` (cat. `thought_level`: off/auto/low/medium/high/xhigh/max).
- claude-agent-acp 0.100: `mode` (default/acceptEdits/plan/auto/bypassPermissions), `model`, `effort` (cat. `thought_level`), `fast` e `ultracode` (cat. `model_config`), `agent` (sem categoria).

Contrato:
- `SessionConfigOptionSchema = { id, name, description?: string|null, category?: string|null } & ({ type: "select", currentValue: string, options: { value, name, description?: string|null }[] } | { type: "boolean", currentValue: boolean })`. O daemon achata `options` agrupadas (`SessionConfigSelectGroup`) numa lista só.
- ~~`Session` ganha `configOptions`~~: desde o Extra (04/11) a `Session` não tem `configOptions` (ver "configOptions fora da Session"). Continua persistido em `sessions.config_options TEXT` (JSON; migração 2 já cria a coluna).
- Fontes: resposta de `session/new` (e futuramente `session/load`), notificações `config_option_update` (substitui a lista) e `current_mode_update` (atualiza o `currentValue` da opção de categoria `mode`). Agente que só manda `modes` (sem `configOptions`) → daemon sintetiza uma opção `{ id: "mode", name: "Modo", category: "mode", type: "select" }` e usa `session/set_mode` para trocar.
- `POST /api/sessions` aceita `config?: Record<string, string | boolean>` aplicado logo após `session/new` (ids desconhecidos ignorados; falha de uma opção vira evento `error`, não derruba a sessão).
- WS cliente → servidor: `set_config { sessionId, configId, value: string | boolean }` → daemon chama `session/set_config_option` (resposta traz a lista nova) → broadcast `session`. Erro → `error { message, sessionId }`.
- PWA: no topo do chat, três seletores compactos pelas categorias `mode` ("Acesso"), `model` ("Modelo"), `thought_level` ("Effort"); as demais opções (`model_config`, sem categoria) num painel "Mais opções". Na criação da sessão, uma folha com os mesmos seletores, pré-preenchida com a última escolha por agente salva em `localStorage` (`nanachi.agentConfig.<agentId>`); como as opções só existem depois de `session/new`, a folha mostra as que a máquina lembrou da última sessão daquele agente e envia em `config`. Trocar durante a sessão é permitido a qualquer momento.

### PWA (Fase 1)
Navegação: Máquina → Workspaces → Sessões → Chat (botão voltar no topo; estado de navegação em memória + `history.pushState` pra o gesto de voltar do iOS funcionar).
- Workspaces: lista; "+ Workspace" abre navegador de pastas (começa em `/api/roots`, entra em subpastas, botão "Usar esta pasta").
- Sessões do workspace: lista com status; "Nova sessão" escolhe o agente (`/api/agents`).
- Chat: mensagens do usuário, texto do agente com markdown (`react-markdown` + `remark-gfm`, chunks concatenados), pensamento recolhido, tool calls como cartões recolhíveis com status e diff (linhas +/− coloridas; diff calculado com a lib `diff`), plano como checklist, cartão de permissão com um botão por opção (allow verde, reject vermelho) que some após responder, indicador "trabalhando…" e botão Parar quando `running`. Input fixo embaixo, respeitando safe-area e teclado.
- Ressincronização: o app guarda o último `seq` por sessão em memória; ao reconectar o WS, reenvia `subscribe` com esse `afterSeq`.

**Pronto quando:** uma mudança num projeto é pedida e aprovada pelo celular.

## Contrato (Fase 2 — Claude Code e retomar sessões)

### Claude Code
- Dependência do daemon: `@agentclientprotocol/claude-agent-acp@^0.100.0` (nada global). Ao spawnar qualquer agente, o daemon PREPENDE `<pacote daemon>/node_modules/.bin` e `<raiz do monorepo>/node_modules/.bin` (os que existirem) ao PATH do processo filho e da resolução de comando. Assim `command: "claude-agent-acp"` funciona (é um `.cmd` no Windows → caminho `shell: true` já existente).
- Default do config passa a ter dois agentes: `omp` (como antes) e `claude: { label: "Claude Code", command: "claude-agent-acp", args: [], env: {} }`. Configs já gravados sem `claude` NÃO são reescritos; o daemon faz merge: agentes default ausentes no arquivo são adicionados em memória (o arquivo do usuário manda quando define o mesmo id).
- Observado (03/11, scratchpad): `claude-agent-acp` 0.100 sobe nativo no Windows, `session/new` funciona com o login local do Claude Code, imprime logs de diagnóstico no stderr (ignorar/debug) e expõe configOptions `mode` (default/acceptEdits/plan/auto/bypassPermissions), `model`, `effort` (thought_level), `fast`, `ultracode` (model_config), `agent`. No modo `default` ele PEDE permissão → é o teste real do cartão de aprovação.

### Retomar sessões
- `POST /api/sessions/:id/resume` (Bearer) para sessão `stopped` ou `error`: sobe o agente no cwd do workspace, `initialize`; se `agentCapabilities.loadSession` → `session/load { sessionId: acp_session_id, cwd, mcpServers: [] }`; senão, se `agentCapabilities.sessionCapabilities.resume` existir → `session/resume` (mesmos params); senão → 409 `{ error: "not_resumable" }` e a sessão fica como está. Durante o `session/load` o agente reenvia o histórico como `session/update`: o daemon NÃO grava nem repassa esses updates (já tem o histórico); só volta a gravar após a resposta do load. configOptions da resposta do load/resume substituem as salvas. Sucesso → status `idle`, evento `status`, broadcast `session`. Falha → status `error` + evento `error`.
- Sessão sem `acp_session_id` → 409 `not_resumable`.
- Várias sessões vivas ao mesmo tempo, de agentes diferentes, no mesmo workspace: já suportado; garantir com teste (duas sessões fake em paralelo, eventos não se misturam).

### PWA (Fase 2)
- Sessão `stopped`/`error`: o chat abre o histórico só leitura com um botão "Retomar" (chama resume; 409 → mensagem "Este agente não permite retomar; abra uma sessão nova"). Input desabilitado enquanto não estiver idle/running.
- Lista de sessões mostra o agente (label) e quanto tempo atrás foi atualizada.
- Abrir o app pelo ícone volta para a última tela (máquina/workspace/sessão) salva em `localStorage` (`nanachi.lastRoute`), e o chat ressincroniza pelo `afterSeq`.

**Pronto quando:** omp e Claude Code rodam juntos e o app reabre onde parou.

## Contrato (Fase 3 — arquivos e notificações)

### Armazenamento
`<NANACHI_HOME>/files/<sessionId>/<fileId>-<nome sanitizado>`. Tabela `files(id TEXT PK, session_id, name, mime, size, direction TEXT CHECK(direction IN ('to_phone','from_phone')), path, created_at)` (migração 3). Limite 50 MiB por arquivo (413 `too_large`). Nome sanitizado: só basename, sem caracteres proibidos no Windows, máx. 120 chars.

### Do PC para o celular: `phone-send`
- O daemon gera um **token de agente** aleatório por sessão (só em memória) e injeta no env do agente: `AGENT_SESSION_ID`, `NANACHI_URL=http://127.0.0.1:<port>`, `NANACHI_AGENT_TOKEN`.
- O daemon também prepende ao PATH do agente a pasta `packages/daemon/bin`, que contém `phone-send.cmd` (Windows) e `phone-send` (sh), ambos chamando `node <daemon>/dist/phone-send.js`. Assim nada é instalado globalmente e só os agentes do daemon têm o comando.
- `phone-send <arquivo> [--caption "texto"]` e `phone-send --screenshot [--caption]`: lê as variáveis, faz `POST {NANACHI_URL}/api/agent/files` com headers `X-Nanachi-Agent-Token`, `X-Nanachi-Session`, `X-File-Name` (URI-encoded), `Content-Type`, corpo cru; imprime "enviado: <nome>" ou erro (exit 1). Sem as variáveis → mensagem "phone-send só funciona dentro de uma sessão do Nanachi Remote".
- `--screenshot`: PowerShell (`-NoProfile -NonInteractive`) com `System.Windows.Forms`/`System.Drawing` capturando `SystemInformation.VirtualScreen` (todos os monitores) para PNG temporário, envia e apaga.
- `POST /api/agent/files`: autenticado SÓ pelo par sessão + token de agente (comparação em tempo constante), NÃO aceita Bearer de device; recusa se a sessão não estiver viva. Grava arquivo + linha + evento `file { fileId, name, mime, size, direction: "to_phone", caption? }` e dispara push.
- `GET /api/files/:fileId` (Bearer de device): baixa com `Content-Disposition` (inline para image/*, attachment para o resto) e `X-Content-Type-Options: nosniff`. O PWA busca com fetch+Bearer e mostra via `URL.createObjectURL` (CSP já permite `blob:`).
- Instrução para os agentes: a linha "Para mandar um arquivo ou print ao usuário, rode `phone-send <caminho>`. Para uma print da tela, rode `phone-send --screenshot`." vai para os arquivos globais de instrução do usuário (é decisão dele: ver `docs/PENDENTES-USUARIO.md`).

### Do celular para o PC: anexos
- `POST /api/sessions/:id/attachments` (Bearer; corpo cru + `X-File-Name` + `Content-Type`) → `{ fileId, name, mime, size }`, grava com `direction: "from_phone"`.
- WS `prompt` ganha `attachments?: string[]` (fileIds da mesma sessão). O daemon monta o prompt ACP: texto + para cada anexo de imagem, se `promptCapabilities.image` → bloco `{ type: "image", data: <base64>, mimeType }`; caso contrário (ou não imagem) → anexa ao texto `\n\n[Arquivo anexado: <caminho absoluto>]`.
- Evento `user_message` ganha `attachments?: { fileId, name, mime, size }[]`.
- PWA: botão de clipe no input (`<input type="file" accept="image/*,*/*" multiple>`, que no iOS oferece câmera, fotos e arquivos), prévia com miniaturas removíveis antes de enviar, upload com progresso, e mensagens mostram as miniaturas/cartões.

### Web Push
- VAPID: gerado na primeira execução em `<NANACHI_HOME>/vapid.json` (`{ publicKey, privateKey, subject: "mailto:nanachi@localhost" }`); a Fase 5 copia o mesmo arquivo para os outros PCs. Biblioteca `web-push`.
- Tabela `push_subscriptions(endpoint TEXT PK, device_id, keys TEXT, created_at)`; coluna `workspaces.muted INTEGER DEFAULT 0` (migração 3).
- `GET /api/push/key` → `{ publicKey }`; `POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }`; `DELETE /api/push/subscribe { endpoint }`; `PATCH /api/workspaces/:id { muted: boolean }` (Workspace ganha `muted`).
- Quando: `turn_end`, `permission_request`, `error` e `file` (to_phone), exceto workspace mudo. Enviado só para devices sem nenhuma conexão WS aberta no momento (com o app aberto, o WS já entrega). Payload JSON `{ title, body, machineId, workspaceId, sessionId, kind }`; título = nome do workspace, body curto ("Terminou", "Pede aprovação: <título>", "Erro: …", "Arquivo: <nome>"). Resposta 404/410 do serviço de push → apaga a inscrição.
- PWA: service worker custom via `injectManifest` (ou `importScripts` no generateSW) com `push` → `showNotification` (tag = sessionId, para agrupar) e `notificationclick` → foca/abre o app e navega para a sessão (postMessage para a janela aberta, ou `openWindow('/?machine=..&session=..')`). Em Ajustes: "Ativar notificações" (só aparece com `navigator.serviceWorker` + `PushManager`; no iOS exige estar aberto pelo ícone), pede permissão por gesto do usuário, inscreve em cada máquina pareada com a chave dela. Toggle "Silenciar" por workspace.

**Pronto quando:** pedir uma print faz ela chegar como notificação.

## Contrato (Fase 4 — Codex, Antigravity e modo terminal)

### Codex (ACP oficial)
- Dependência do daemon `@agentclientprotocol/codex-acp@^2.5.0`; default `codex: { label: "Codex", command: "codex-acp", args: [], env: {} }` em `DEFAULT_AGENTS`.
- Observado (03/11): sobe nativo no Windows com o login local do Codex (codex-cli 0.159.1); configOptions `mode` (read-only/workspace-write/agent/agent-full-access), `collaboration_mode` (default/plan; categoria própria → vai para "Mais opções"), `model`, `reasoning_effort` (thought_level), `fast-mode` (model_config). Sandbox do Windows (`elevated`) é configuração do próprio Codex (`~/.codex/config.toml`), não do daemon.

### Modo terminal (PTY) e Antigravity
- O adaptador ACP do Antigravity é de terceiros e NÃO é instalado sem aprovação do usuário (ver PENDENTES). O Antigravity entra pelo modo terminal, que roda o `agy` oficial (1.4.12 instalado) e é o plano B genérico para qualquer agente.
- `AgentConfigSchema` ganha `kind: "acp" | "pty"` (default `"acp"`). Default novo: `agy: { label: "Antigravity", kind: "pty", command: "agy", args: [], env: {} }`.
- Daemon: `@lydell/node-pty` (fork com binários prontos; NÃO exigir build tools). Sessão PTY: spawn no cwd do workspace, `cols`/`rows` iniciais 80x24, mesmo env/PATH dos agentes ACP (inclui `phone-send`). Saída agregada em janelas de 50 ms (ou 16 KiB) gravada como evento `terminal_output { data }` (string UTF-8, com ANSI). Status `running` enquanto o processo vive; saída do processo → evento `terminal_exit { exitCode }` e status `stopped`. Sem configOptions. Resume → 409 `not_resumable`. Prompt ACP numa sessão PTY → erro `not_acp`. Teto de 8 sessões vivas vale para os dois tipos.
- `Session` ganha `kind: "acp" | "pty"`; `/api/agents` devolve `kind` por agente.
- WS cliente → servidor: `terminal_input { sessionId, data }` (máx. 64 KiB) e `terminal_resize { sessionId, cols: 10..500, rows: 5..200 }`.
- Push: sessão PTY dispara push `turn_end` quando o processo termina (body "Terminal encerrado").
- PWA: sessão `pty` abre tela de terminal com `@xterm/xterm` + `@xterm/addon-fit` (tema escuro, fonte monoespaçada, ajusta ao tamanho e manda `terminal_resize` com debounce), replay dos `terminal_output` no subscribe, barra de teclas para celular (Esc, Tab, Ctrl+C, Ctrl+D, ↑ ↓ ← →, Enter) e uma linha de texto que envia `texto + "\r"` (o teclado do iOS digitando direto no xterm é ruim). Cópia de texto: seleção do xterm + botão "Copiar".

**Pronto quando:** os quatro agentes respondem pelo app.

## Contrato (Fase 5 — vários PCs e acabamento)

### Vários PCs
- O PWA é instalado a partir do PC principal (`https://principal.<tailnet>.ts.net`) e fala direto com os outros daemons (`https://outro.<tailnet>.ts.net`). No daemon de cada PC secundário, `corsOrigins` inclui a origem do principal. CORS: só `GET/POST/PATCH/DELETE`, headers `Authorization, Content-Type, X-File-Name`, sem credenciais (cookies não são usados).
- WebSocket: o daemon passa a checar o header `Origin` no upgrade: aceita ausente (clientes não-browser), a própria origem (host do request) e as de `corsOrigins`; qualquer outra → 403 antes do upgrade.
- Pareamento de outra máquina pelo app já funciona via `baseUrl` (https obrigatório).
- VAPID compartilhado: CLI `vapid show` imprime o caminho e a chave pública; documentação manda copiar o `vapid.json` do principal para os outros antes de ativar notificações. Com a mesma chave, uma inscrição do iPhone serve a todas as máquinas: o PWA, ao ativar notificações, inscreve a MESMA subscription em todas as máquinas cuja chave pública for igual (e avisa das diferentes).

### Contexto do workspace e diffs
- `GET /api/workspaces/:id/info` → `{ branch: string|null, changedFiles: number|null, instructions: string[] }` (git via `execFile('git', [...], { cwd })`, nunca shell; `instructions` = quais de `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` existem na raiz). Não-git → `branch/changedFiles: null`.
- `GET /api/sessions/:id/diff` → `{ files: { path, status: "added"|"modified"|"deleted"|"renamed", additions, deletions, patch: string }[], truncated: boolean }` = `git diff HEAD` (+ arquivos não rastreados como added) no cwd da sessão; limite total 1 MiB (truncated). Não-git → `{ files: [], truncated: false }`.
- PWA: cabeçalho do workspace mostra branch, nº de alterações e chips das instruções; chat ganha aba/botão "Alterações" com a lista de arquivos e o patch de cada um (reaproveita DiffView com unified patch).

### Worktrees
- `POST /api/sessions` aceita `worktree?: boolean`. Se true e o workspace é repo git: `git worktree add -b nanachi/<id curto> <NANACHI_HOME>/worktrees/<workspaceId>/<id curto> HEAD`; a sessão roda com esse cwd. `Session` ganha `worktree: { path, branch } | null` (coluna `sessions.worktree TEXT NULL`, migração 4). Workspace não-git + worktree → 400 `not_git`.
- `DELETE /api/sessions/:id?removeWorktree=1` remove o worktree (`git worktree remove`; sujo → 409 `worktree_dirty`, a sessão para mesmo assim) e apaga o branch só se já estiver mergeado (`git branch -d`). Sem o parâmetro, o worktree fica.
- PWA: checkbox "Em worktree separado" na folha de nova sessão (só se o workspace for git); chip do branch no chat; ao encerrar uma sessão com worktree, pergunta se remove.

### Dispositivos
- `GET /api/devices` → `{ devices: { id, name, createdAt, lastSeenAt: number|null, current: boolean }[] }` (não revogados); `DELETE /api/devices/:id` revoga (derruba WS na hora, apaga inscrições push). Revogar o próprio device é permitido, com confirmação no app, e leva o app à tela de pareamento.
- PWA: Ajustes → "Dispositivos desta máquina".

### Início automático
- CLI `autostart install|uninstall|status`: cria/remove a tarefa do Agendador "Nanachi Remote" com gatilho "ao fazer logon" do usuário atual, nível normal (não admin), rodando `wscript.exe "<NANACHI_HOME>\start-hidden.vbs"` (o VBS sobe `node "<daemon>\dist\main.js"` sem janela e com log em `<NANACHI_HOME>\daemon.log`). Gerado via `schtasks.exe` com argumentos em array (sem shell). Testes cobrem a montagem dos comandos e do VBS; EXECUTAR o install é do usuário.
- Daemon na sessão interativa do usuário (não serviço), requisito do `--screenshot`.

### Documentação final
- `README.md` na raiz: o que é, requisitos, instalação, uso diário, comandos (pair, devices, revoke, vapid, autostart), vários PCs, segurança, solução de problemas. Em português.

**Pronto quando:** trocar de PC no seletor e continuar trabalhando.

## Extra (pedido do usuário em 03/11) — retomar sessões criadas fora do app

Objetivo: no app, abrir uma sessão que foi criada no terminal do PC (`omp`, `claude`, `codex`) naquela pasta, como um `--resume`.

Observado (03/11): `initialize` de omp, claude-agent-acp e codex-acp anuncia `sessionCapabilities.list` e `loadSession: true`. `session/list { cwd }` devolve `{ sessions: { sessionId, cwd, title?, updatedAt? }[], nextCursor? }`. O codex-acp devolveu página vazia COM `nextCursor` — é preciso seguir o cursor.

Contrato:
- shared: `AgentSessionSummarySchema = { acpSessionId, title: string|null, updatedAt: number|null (ms), linkedSessionId: string|null }`; `AgentSessionsResponseSchema = { supported: boolean, sessions: AgentSessionSummary[], nextCursor: string|null }`; `CreateSessionRequest` ganha `resumeAcpSessionId?: string` (min 1).
- `GET /api/workspaces/:id/agent-sessions?agent=<id>&cursor=<opcional>` (Bearer): agente `pty` ou sem `sessionCapabilities.list` → `{ supported: false, sessions: [], nextCursor: null }`. Senão sobe um processo temporário do agente (mesmo spawn/env/PATH das sessões, cwd = workspace), `initialize`, `session/list { cwd, cursor? }`, mata o processo. Filtra `cwd` igual ao do workspace (normalizado, case-insensitive no win32). Se a página filtrada vier vazia e houver `nextCursor`, segue até 5 páginas antes de responder. Ordena por `updatedAt` desc. `linkedSessionId` = sessão do daemon que já usa aquele `acp_session_id` (se houver). Timeout 30 s → 504 `agent_timeout`. Não conta no teto de 8 sessões; no máximo 1 listagem simultânea por agente (429 `busy`).
- `POST /api/sessions { workspaceId, agent, resumeAcpSessionId, config? }`: cria a sessão do daemon já com `acp_session_id`, título = título da listagem se o cliente mandar (ou "Sessão retomada"), sobe o agente, `initialize`, `session/load` (ou `session/resume` se não houver loadSession). DIFERENTE do resume normal: aqui o histórico reenviado durante o load É gravado como eventos (é a única cópia que o app terá); limite de 5000 eventos importados (o resto descartado com um evento `error` informativo "histórico truncado"). Depois aplica `config` e fica `idle`. Se a mesma `acpSessionId` já estiver ligada a uma sessão viva do daemon → 409 `already_running` com `{ sessionId }` no corpo. Ligada a uma sessão parada → 409 `already_linked` com `{ sessionId }` (o app abre essa e oferece Retomar).
- PWA: na tela de sessões do workspace, botão "Retomar do PC" → escolher agente (só ACP) → lista com título, tempo relativo e selo "já no app" quando `linkedSessionId` → tocar cria a sessão e abre o chat (ou abre a ligada, nos 409). "Carregar mais" quando houver `nextCursor`. Estados de carregando (pode levar alguns segundos: o agente sobe) e "Este agente não lista sessões".

## Extra (03/11) — imagens do agente e aviso do phone-send

### Imagens enviadas pelo agente via ACP
- Hoje o mapeamento ACP→eventos só mantém texto e diff. Passar a aceitar blocos `image` (`{ type: "image", data: <base64>, mimeType, uri? }`) em: `agent_message_chunk`/`agent_thought_chunk` (conteúdo da mensagem) e no `content` de `tool_call`/`tool_call_update` (`{ type: "content", content: { type: "image", ... } }`). Também `resource_link`/`resource` cujo mime seja imagem raster e cuja `uri` seja `file://` de um arquivo DENTRO das `allowedRoots` (validar com `resolveInsideRoots`; fora → ignorar).
- Cada imagem vira arquivo da sessão (mesmo armazenamento da Fase 3, `direction: "to_phone"`, nome `imagem-<n>.<ext>`; só png/jpeg/gif/webp; limite de 50 MiB e cota por sessão valem). Não gerar push para essas imagens (só o `phone-send` explícito notifica). Deduplicar pelo hash do conteúdo dentro da sessão (o mesmo base64 reenviado em tool_call_update não cria outro arquivo).
- Eventos: imagem em mensagem → evento `file` (com `caption` vazio); imagem em tool call → `ToolContent` novo `{ type: "image", fileId, mime }` (shared). O PWA renderiza inline (miniatura via blob, toque abre o visualizador existente com Salvar/Compartilhar).

### Aviso do phone-send (decisão do usuário: "o app avisa")
- O daemon acrescenta ao PRIMEIRO prompt de cada sessão ACP criada pelo app (não nas importadas/retomadas, que já têm contexto) um bloco de texto curto, depois do texto do usuário:
  `[Nanachi Remote] O usuário está no celular. Para mandar um arquivo ou imagem a ele, rode no terminal: phone-send "<caminho>" (opcional: --caption "texto"). Para mandar uma print da tela do PC: phone-send --screenshot.`
- Config `phoneSendHint: boolean` (default true) para desligar. O evento `user_message` gravado NÃO mostra esse bloco (o app exibe só o que o usuário digitou).

## Extra (03/11) — conta logada em cada harness (Ajustes)

- shared: `AgentAccountSchema = { agentId, label, status: "logged_in"|"logged_out"|"unknown", account: string|null, detail: string|null, checkedAt: number }`; `AgentAccountsResponseSchema = { accounts: AgentAccount[] }`.
- `GET /api/agents/accounts[?refresh=1]` (Bearer): uma entrada por agente do config. Cache em memória de 5 min (refresh força). Cada verificação com timeout de 15 s, `execFile` sem shell, `windowsHide`, e em paralelo.
- Fontes observadas (03/11):
  - Claude Code: `claude auth status` imprime JSON (`loggedIn`, `email`, `orgName`, `subscriptionType`, `authMethod`). account = email; detail = "<orgName> · <subscriptionType>".
  - Codex: `codex login status` ("Logged in using ChatGPT") + `~/.codex/auth.json` (`auth_mode`, `tokens.id_token`). Decodificar SÓ o payload do `id_token` (base64url, sem verificar) para pegar `email` e o plano (`https://api.openai.com/auth` → `chatgpt_plan_type`, se existir). account = email; detail = "ChatGPT · <plano>" ou "API key" quando `auth_mode`/`OPENAI_API_KEY` indicar.
  - Oh My Pi: sem comando de status; credenciais em `~/.omp/agent/agent.db` (SQLite) e config em `~/.omp/agent/config.yml`. Descobrir de forma somente-leitura quais provedores estão autenticados e, se houver, o e-mail/conta (ex. payload de id_token de OAuth). detail = provedores (ex. "openai-codex").
  - Antigravity: dados em `~/.gemini/antigravity-cli` (e afins). Descobrir somente-leitura se há login e o e-mail. Hoje está deslogado nesta máquina → deve aparecer `logged_out`.
- NUNCA devolver ou logar tokens, chaves ou segredos — só e-mail, nome de organização, plano e nomes de provedores. Ler bancos com `readonly`. Falha/indeterminado → `unknown` com detail curto.
- PWA: Ajustes → seção "Contas dos agentes" da máquina selecionada: por agente, bolinha de status, e-mail, detalhe e "Verificado há X"; botão "Atualizar" (refresh=1). Texto de ajuda para deslogado: "Faça login no terminal do PC (ex.: `claude`, `codex login`, `agy`)."

## Extra (04/11) — reload do build e retomada automática

Vale só com `--reload-on-build` (o supervisor usa). Motivo: o reload derrubava conversas `idle` (viravam `stopped`) enquanto um agente editava o código.

- Config: `reloadQuietMs: number` (inteiro ≥ 0, padrão `60000`). O `ReloadWatcher` recarrega só quando passaram esses ms sem nenhuma mudança nas pastas de build E nenhuma sessão `starting`/`running`/`awaiting_permission`. Cada mudança reinicia o silêncio; se há sessão ocupada, a contagem só corre depois do silêncio, e uma nova mudança cancela a contagem.
- Shutdown por reload (exit 75, único caso): antes de matar os agentes, grava `<NANACHI_HOME>/resume-after-reload.json` = `{ savedAt: ms, sessionIds: string[] }` com as sessões `status = 'idle'` e `kind = 'acp'`. SIGINT/SIGTERM não gravam.
- Subida: lê e apaga o arquivo ANTES de marcar tudo como `stopped`. Se `savedAt` tem mais de 10 min, a lista é descartada. Depois de escutar, retoma cada id por `SessionManager.resume(id, { markStarting: true })`: grava `starting`, carrega com `session/load` (o replay é descartado), volta a `idle`. Até 2 retomadas ao mesmo tempo, dentro do teto de 8 sessões vivas. Falha de uma sessão (exceção ou status diferente de `idle`) vira warn no log; as outras seguem.
- `resume` manual (`POST /api/sessions/:id/resume`) não muda: não grava `starting`.
- PTY não é retomado (fica `stopped`), como antes.

## Extra (04/11) — comandos dos harnesses

Pedido do usuário (04/11): suporte aos comandos, skills e menus dos agentes (ex.: `/loop` do omp, `/mcp`, `/alguma-skill`).

Observado (04/11): probe ACP sem prompt (`initialize` + `session/new`, espera de alguns segundos). Cada agente manda UMA notificação `session/update` com `sessionUpdate: "available_commands_update"`, logo depois do `session/new`.
- omp 18.13.2: 83 comandos. Built-ins sem prefixo (`/mcp` hint `<subcommand>`, `/model`, `/compact`, `/session`, `/plugins`…), skills como `skill:<nome>` (hint `arguments`), extensões (`/claude`, `/agy`, `/re-spawn`…). **Não anuncia `/loop`.**
- claude-agent-acp 0.100.0: 115 comandos. `/loop` (hint `[interval] [prompt]`), `/mcp` (hint `[reconnect|enable|disable [<server>|all]]`), `/effort`, `/model`, `/compact`. Skills sem prefixo (`brainstorming`) e de plugin com `plugin:skill` (`superpowers:brainstorming`).
- codex-acp 2.5.0: 66 comandos. `/plan`, `/mcp` (hint `[reconnect]`), `/skills`, `/review`, `/goal`. Skills com `$` (`$brainstorming`, `$computer-use:computer-use`).
- Elicitation: nenhum dos três mandou `elicitation/create` no initialize nem no session/new, e nenhum anuncia capacidade específica. O daemon declara `clientCapabilities: {}`, então não deve receber. Não implementado: sem caso observado, e o MCP elicitation só apareceria durante tool call (exige prompt para ver).
- Payload medido (JSON de `{name, description, hint}`): omp 15,7 KB; claude 37,8 KB; codex 20,2 KB. Por isso a lista saiu da `Session` (ver Contrato).

Contrato:
- shared: `AvailableCommandSchema = { name: string, description: string, hint: string|null }`. A `Session` NÃO tem `commands` (listagem, GET e broadcast `session` ficam leves).
- `GET /api/sessions/:id/commands` (Bearer) → `{ commands: AvailableCommand[] }` (`CommandsResponseSchema`), lido da coluna `sessions.commands` (`findSessionCommands`). 404 se a sessão não existe. Lista vazia se o agente nunca anunciou.
- ServerMessage `commands { sessionId, commands }`, enviada SÓ aos clientes inscritos na sessão: (a) no `subscribe`, logo depois do replay, se a lista não estiver vazia; (b) quando a lista muda. Lista igual à gravada não é reenviada nem regrava a linha.
- SQLite, migração 6: `sessions.commands TEXT NOT NULL DEFAULT '[]'` (JSON da lista). A linha do banco é a fonte. Sessão parada ou retomada mantém a lista até o agente mandar outra.
- `available_commands_update` → `availableCommandsOf()` (puro: item sem nome sai; nome repetido fica só na primeira ocorrência) → `setCommands` (grava, avisa inscritos). Vale também durante o replay do `session/load` (não é histórico, então não vira evento nem entra em `events`).
- PWA: o chat carrega a lista pelo GET ao abrir (`api.sessionCommands`) e atualiza pela mensagem `commands`. Se a mensagem chegou antes do GET responder, o GET não sobrescreve. Falha do GET não tem aviso: o subscribe reenvia a lista se houver.
- Enviar comando = prompt de texto `"/<nome> <args>"`, como o ACP define. Nenhuma mensagem nova no WS. Daemon: `isSlashCommand(text)` (`/` seguido de caractere sem espaço, no começo). Prompt de comando NÃO leva o aviso do phone-send e NÃO consome o `phoneHintPending`: o aviso sai no primeiro prompt que não é comando.
- PWA (`chat/commands.ts`, puro e testado): `slashQuery(text, caret)` (menu abre com `/busca` no começo, sem espaço); `filterCommands` (ranking: nome começa com a busca > nome contém > descrição contém; empate mantém a ordem do agente); `insertCommand(text, caret, name, 'typed' | 'prefix')` (`typed` troca o `/busca` do começo e mantém o resto; `prefix`, pelo botão, põe `/<nome> ` antes do texto); `splitCommand` (primeiro token de mensagem que começa com `/`).
- Composer: digitar `/` no começo abre o menu; o botão `/` ao lado do clipe abre o mesmo menu com campo de busca (× fecha). Menu no fluxo acima do composer (empurra a conversa, não cobre o campo), rolagem própria com altura máxima, itens ≥ 44px. O toque usa `mousedown` com `preventDefault`: o campo (ou a busca) mantém o foco e o teclado do iOS não fecha. Sem comandos: "Este agente não anunciou comandos.". Sem casamento: "Nenhum comando combina com “x”.".
- Mensagem do usuário que começa com `/comando`: primeiro token em mono, com fundo translúcido sobre a bolha.
- Fake agent: `FAKE_AGENT_COMMANDS=1` anuncia 4 comandos (`loop`, `mcp`, `skill:brainstorming`, `eco`); `/eco <texto>` responde só com o texto. E2E: `npm run e2e:commands` (porta 7802), screenshots em `e2e/screenshots/commands/`.

Limites e pontos em aberto:
- Medido no banco real (04/11, leitura somente): listagem de uma pasta com 2 sessões (omp + claude) caiu de 143.394 para 89.860 bytes. Sobra quase tudo em `configOptions` do omp (~86 KB por sessão), que vai na `Session`. Resolvido na seção "configOptions fora da Session" abaixo.
- Codex: o nome vem com `$` (`$brainstorming`). O ACP manda `/<nome>`, então o texto enviado é `/$brainstorming`. Não verificado com prompt real (a investigação não gasta prompts): se o codex-acp não reconhecer, o ajuste é só no `insertCommand`.
- `/loop` existe no claude e não no omp (apesar do pedido). Um `/loop` digitado num omp vai como texto e o agente decide o que fazer.
- Só o agente decide o efeito de um comando: o daemon não executa nada, só repassa o texto.

## Extra (04/11) — configOptions fora da Session

Motivo: `configOptions` do omp pesa ~86 KB por sessão (lista de modelos). Ia em toda listagem de sessões e em todo broadcast `session` para todos os clientes. Mesmo modelo do Extra de comandos: sai da `Session`, vai por GET e por mensagem só para os inscritos.

Contrato:
- shared: `SessionSchema` sem `configOptions`. `SessionConfigOptionSchema` continua. `ConfigOptionsResponseSchema = { configOptions: SessionConfigOption[] }` (http.ts).
- `GET /api/sessions/:id/config` (Bearer) → `{ configOptions }`, lido da coluna `sessions.config_options` (`findSessionConfigOptions`). 404 se a sessão não existe. Lista vazia se o agente nunca mandou opções. Sem migração: a coluna já existia.
- ServerMessage `config_options { sessionId, configOptions }`, enviada SÓ aos clientes inscritos na sessão: (a) no `subscribe`, depois do replay, se a lista não estiver vazia; (b) quando muda. Durante o replay não manda (a lista lida depois dele já inclui a mudança).
- `persistConfig(live)` é o ponto único: compara com o banco; igual não regrava a linha nem avisa; diferente grava e avisa `SessionListener.configOptions`. Passa por ele: resposta de `set_config` (`applyConfig`), `config_option_update`, `current_mode_update`, `session/new`, `session/load` (resume e importação).
- O broadcast `session` não é mais disparado por `setConfig`, `config_option_update`, `current_mode_update` nem por mudança de comandos (a Session não carrega nada disso).
- PWA: `useChat` carrega `configOptions` por GET ao abrir e atualiza pela mensagem `config_options` (se a mensagem chegou antes do GET responder, o GET não sobrescreve). `ChatScreen` lê `controller.configOptions` (seletores Acesso/Modelo/Effort e "Mais opções"). A folha de nova sessão continua usando o localStorage, que o hook atualiza quando a lista muda.
- Antes: listagem de uma pasta com 2 sessões (omp + claude) = 89.860 bytes, quase tudo `configOptions`. Depois: a listagem não carrega opções. Não remedido no banco real.

Testes: daemon (`agent-support.fetchConfigOptions`, `session-ws` com os casos de inscrito/não inscrito, subscribe e reenvio igual), shared (`session`, `ws`, `http`), PWA (`apiClient` com GET /config). E2E: `e2e:commands` e `e2e:34` passam; nenhum E2E lia `configOptions` da Session.

## Extra (04/11) — menus nativos para comandos

Request (04/11): commands that open a menu in omp or Claude Code (`/usage`, `/model`, `/mcp`) reached the chat as plain text. omp `/usage` replied with a code block holding raw ANSI SGR escapes, shown literally. The user wants these commands to open the app's own sheets instead of going straight to the chat.

Observed (ACP probe, 04/11; omp 18.13, claude-agent-acp 0.100, codex-acp 2.5): no command opens a picker over ACP. Every one replies with text. Hints announced: omp `/mcp <subcommand>`, `/session [info|delete|pin [account]]`, `/usage [show|reset [provider/credential-id|provider/active]]`, `/model` (no hint); claude `/model <model>`, `/effort <low|medium|high|xhigh|max|auto|ultracode [on|off]>`, `/mcp [reconnect|enable|disable [<server>|all]]`, `/config key=value`; codex `/mcp [reconnect]`. All three expose configOptions with categories `mode`, `model` and `thought_level`.

Rules (PWA only; daemon, shared schemas and the stored rows do not change):
1. **ANSI.** Agent text never shows raw escapes. `chat/ansi.ts` `stripAnsi` removes CSI (SGR included) and OSC sequences, plus an unfinished sequence at the end of a streaming chunk. It runs when agent text is rendered (`MarkdownText` for `agent_message`, and the thought text). The reducer and the database keep the raw text.
2. **Native pickers for config options.** When the user picks a command from the slash menu, or sends the bare command (no arguments), `nativePickerFor(name, configOptions)` maps it to a category: `model` → `model`; `effort` → `thought_level`; `mode`, `permissions`, `approvals` → `mode`. If the session has a select option of that category, a sheet titled `/<name>` opens instead of sending text. Options show names and descriptions, the current value is checked, and a muted row "Enviar /<name> ao agente" sends the text. Choosing an option calls the same `setConfig` path as the header selectors; no prompt is sent. With arguments (`/model opus`) the text is sent, as before.
3. **Subcommand sheet from the hint.** `parseHintChoices(hint)` returns the top-level alternatives when the whole hint is one bracketed (`[...]`, optional) or angled (`<...>`, required) group with `|` alternatives, or a single bracketed literal (`[reconnect]`). Each alternative is a literal word with a flag `takesArgument` when it has more text after it (`disable [<server>|all]`). A trailing argument with a placeholder (`<...>`) is shared by the alternatives after the first one, so `enable` and `disable` take `[<server>|all]` and `reconnect` does not. A trailing argument with only literals (`[on|off]`) belongs to its own alternative. Anything else (`<subcommand>`, `<model>`, `key=value`, `arguments`, `[interval] [prompt]`, null) returns undefined. When the user picks such a command from the slash menu and rule 2 does not apply, the sheet lists "Sem argumento" (only when the group is optional), each choice in mono, and a muted "Digitar argumentos…". A choice without `takesArgument` is sent at once as `/<name> <choice>`; one with it inserts `/<name> <choice> ` in the composer and focuses it. "Sem argumento" sends `/<name>`. Commands without choices keep today's behavior (insert into the composer).
4. **Sheets.** They reuse `ActionSheet` (portal on `body`, `useModalOverlay`: tap outside, Esc and the browser back close them). Rows are at least 44px. Long option lists scroll inside the sheet, and Cancel stays visible. Safe-area bottom is respected.
5. **Typed trigger.** Opening a sheet from the menu removes the `/busca` that opened the menu from the composer. The bare command typed and sent (`/model` + Enviar) opens the sheet and clears the composer; it is not sent.

Out of scope: elicitation (no agent in the probe sends it); a daemon-side command registry; reading the agent's menus over a second channel.

Tests: PWA unit tests for `stripAnsi` (with the real omp sample), `nativePickerFor` and `parseHintChoices` (all the hints above), and a static-markup test for the sheet panel. E2E (`npm run e2e:commands`): the model picker changes the model with no user message; `/mcp` shows the subcommand sheet and `reconnect` sends `/mcp reconnect`; `/usage` replies with ANSI and the chat shows none of it. Screenshots at 390×844 in `e2e/screenshots/commands/`.

## Extra (04/11) — uso do agente e editar o Nanachi

Request (04/11): a button inside a session shows the agent's own usage and rate limits, and Settings can open the Nanachi repository as a workspace so an agent can edit Nanachi from the app. This section is the contract; the daemon implements it. The PWA part comes later.

### 1. Usage (`POST /api/sessions/:id/usage`)

Probe (04/11; ACP, agents idle, only local commands, no LLM prompt). The probe script and its saved output live in the session scratchpad (`menu-probe/probe.mjs`, `out-20261104-002122/*.result.json`); the claude row was re-run alone (`out-claude-usage/claude.result.json`):

| Agent | Command | What the reply shows |
| --- | --- | --- |
| claude-agent-acp 0.100.0 | `/usage` (announced as "Show session cost, plan usage, and what's contributing to your limits") | "5-hour limit" and "Weekly · all models" percentages with reset times, session cost, what fills the limits. Stop reason `end_turn`, no tool call. |
| omp 18.13.2 | `/usage` (hint `[show\|reset …]`) | "5 hours" and "7 days" percentages per account, plus Cursor and OpenAI Codex blocks. The text is a code block with raw ANSI SGR escapes; the PWA strips them. |
| codex-acp 2.5.0 | `/status` (`/usage` is not announced) | "codex 5h limit: 9% left" and "codex Weekly limit: 86% left". Token usage shows "data not available yet". No other announced codex command shows limits. |

Mapping, by agent id as in `DEFAULT_AGENTS`: `omp` → `/usage`, `claude` → `/usage`, `codex` → `/status`. Any other id, and any PTY agent, → 400 `usage_unsupported`. The command is sent as a text prompt, so it is local only: never a prompt that calls the LLM.

Revision (04/11, night): the command no longer runs on the session's connection. Usage is per agent account, so the daemon runs it on a separate ACP process per agent kind (`usage-probe.ts`). It works while the session is running, awaiting permission, stopped or in error, and it never waits for a turn to end.

Contract:
- shared: `UsageResponseSchema = { agent: string, text: string, fetchedAt: number, cached?: true }` (http.ts). Bearer, same guards as the other session routes. `cached: true` appears only when the reply comes from the daemon cache.
- Process: the probe starts the agent the way a session does (`agentLaunch`: agent config, env, `agent-command.ts`, a probe token), with cwd `<NANACHI_HOME>/usage-probe/<agent id>`. It sends `initialize`, then `session/load` or `session/resume` of the saved probe session (`<NANACHI_HOME>/usage-probe/<agent id>.session`) when the agent can restore sessions and the saved one still loads. Otherwise it sends `session/new` and saves the new id. Then it sends the command as a text prompt. Permission requests get `cancelled`.
- One probe per agent kind. It lives 2 min after its last read (`USAGE_IDLE_MS`), then it is killed; the next read starts another one and restores the saved session.
- One read at a time per agent kind. Concurrent requests await the same promise: one probe, one command.
- Cache: the last successful reply per agent kind is returned for 30 s (`USAGE_CACHE_MS`) with `cached: true`. Failures are not cached.
- Output: only the text chunks of the command turn go into the reply. Nothing the probe sends is recorded as an event or broadcast, and the session row and its status are not touched.
- Timeout: 30 s for the whole read (start, negotiation and the command). On timeout the daemon sends `session/cancel`, waits up to 5 s for the command to end, kills the probe and answers 504 `agent_timeout`.
- Shutdown and reload: probes are registered in the daemon's running processes, so `sessions.shutdown()` (the `onClose` hook) kills them with the session agents; `UsageProbe.close()` also clears the idle timers.
- Errors: 404 `not_found`; 400 `usage_unsupported` (PTY or unmapped agent); 502 `agent_failed` when the probe exits or fails before answering (the reason goes to the daemon log, not the body); 504 `agent_timeout`. `session_busy` and `session_not_active` are no longer produced by this route. Their codes stay in shared and in the daemon, because the PWA maps them.
- Reply: `200 { agent, text, fetchedAt }`, plus `cached: true` on a cache hit. `text` keeps the ANSI escapes.
- Limitation: every probe session is a session in that agent's own history, under the `usage-probe` folder. The app's project lists do not show it, because `usage-probe` is not a workspace, but the agent's own session lists can. An agent that cannot restore sessions gets a new probe session each time a probe starts.

### 2. Edit Nanachi from Nanachi (removed from the PWA on 05/11)

- **Removed by user decision (05/11).** The PWA no longer has the Settings row "Editar o Nanachi", its drawer (agent picker and workspace/session creation for the Nanachi repository) or the `getSelf` client call. The generic new-session flow and the "Nova versão do Nanachi" update prompt stay.
- **Daemon route removed (05/11, "Extra (05/11) — terminal no workspace e entrar com Tailscale", item 1).** `GET /api/self`, `packages/daemon/src/self.ts`, its test and `SelfResponseSchema` in shared are gone. Nothing else used them.
- `AGENTS.md` gets a "Live supervisor" section (and `CLAUDE.md` imports it), so an agent that opens the repository from the app does not race the watch build.

Tests: daemon `agent-usage` (fake agent): usage works while the session runs; stopped and error sessions answer 200; the probe is reused in the idle window; concurrent calls spawn one probe and one command; the cache answers `cached: true` and expires; a read after the idle window restores the saved probe session; a timeout sends `session/cancel` and kills the probe; a probe that dies gives 502; closing the daemon kills the probe; no event, broadcast, session row or status change; PTY and unmapped agents give 400; unknown session 404, daemon `self` (repo root detection; `insideAllowedRoots` true and false), shared (`http` schemas).

## Extra (04/11) — retomar ao enviar

Request (04/11): after a PC reboot every session is `stopped`. Sending a message used to fail with `session_busy` "sessão não está ativa", and the user had to press Retomar first. Now a prompt resumes the session by itself.

- `SessionManager.prompt` (WS `prompt`): when the session has no live process and its status is `stopped` or `error`, it first runs the same resume as `POST /api/sessions/:id/resume` (`resume()`), with `markStarting: true`. Subscribers see `starting`, then `idle`, then the prompt goes out as usual. The phone-send hint rules do not change: the resume does not set the first-prompt hint.
- Order inside `prompt`: attachment ids are validated first (an invalid id never starts an agent), then the resume, then the attachments are read (images inline depend on the resumed agent's `promptImage`), then the state check. Nothing after the state check awaits.
- One resume per session at a time. `resume()` registers the attempt; a second call (manual button, reload resume, or a prompt) gets the same promise and never spawns a second agent. A manual resume that is already running also makes a prompt wait for it. Two quick prompts on a stopped session: the first one waits for the resume and sends; the second one waits for the same resume, then finds the turn running and gets `session_busy` ("sessão não está ociosa (status: running)"), like any prompt sent during a turn. The second text is not recorded and is not queued.
- Failure: if the resume fails after the agent was started (initialize or `session/load` error, timeout, agent exits), the prompt fails with the resume's message as a `SessionError` (`agent_failed`). The session ends as `error` with the usual `error` event (the same as a failed manual resume). No `user_message` is recorded.
- Non-resumable sessions (PTY, no `acp_session_id`, or an agent without `loadSession`/`resume`) fail with `not_resumable` and the message "sessão encerrada e não pode ser retomada; crie uma nova". The session stays as it was.
- The HTTP resume route keeps its contract (200 with status `error` on a failed start, 409 `not_resumable`). The usage route (`POST /api/sessions/:id/usage`) does NOT auto-resume: it still answers 409 `session_not_active`.
- Timeouts: the WS handler does not wait for the prompt (each message runs on its own), so a long resume (up to the 60 s start timeout per step) has no earlier cut-off. The PWA clears the draft when the socket accepts the message, so a failed resume shows an error notice but the typed text is gone (known limit: the protocol has no per-prompt ack).
- PWA: the composer accepts text in `stopped` and `error` when the session is resumable, the send button follows the same rule, and the placeholder says the send resumes the session. The Retomar button stays.

Tests: daemon `prompt-resume` (fake agent: a prompt on a stopped session resumes and replies; a prompt during a manual or prompt-started resume does not spawn a second agent; resume failure propagates with no `user_message`; a non-resumable and a PTY session give the clear message); e2e `run-resume` (stop a session, send without pressing Retomar, see the agent reply, one `session/load`).

## Extra (04/11) — releases do PWA

**Problem.** The watch build published by renaming `dist-next` over `dist`. A directory handle held by any process (a dev server, an editor watcher, Explorer, antivirus) made the rename fail with EPERM; the watch plugin threw and the vite process crashed. Updates stopped until the handle was released.

**Design.**
- The watch build writes to `packages/pwa/releases/.building/`, which is never served. vite-plugin-pwa writes `sw.js` and the precache there, as before.
- Publication (`publishRelease`, `packages/pwa/build/atomic-output.ts`): copy the staging folder into a new `releases/<id>/` (`YYYYMMDDTHHMMSSmmmZ-<6 hex>`, so names sort by time); write `releases/current.json` as `{"release":"<id>"}` to a temporary file; rename it over `current.json` (retried on EBUSY, EPERM, EACCES, ENOTEMPTY). Nothing already served is touched before the pointer rename, so until it succeeds the previous release is still the one served.
- Failure: a publication that fails removes its new folder and logs `PWA não publicado: ... A versão anterior continua no ar.` The watch process never throws (`publishWatchRelease`).
- Prune: keep the three newest releases. A release that cannot be removed is a warning, and the next publication retries it. Prune never fails a publication.
- Daemon (`packages/daemon/src/pwa-root.ts`): the root is resolved per request. The pointer is re-read only when its inode, size or mtime changes. A valid pointer whose release has an `index.html` selects that release. No pointer selects `packages/pwa/dist`, so `npm run build` and older plugins keep working. An invalid pointer or a missing release keeps the last good release and logs one warning. Names outside the release format are rejected, so the pointer cannot point outside `releases/`.
- Static files: `reply.sendFile(file, root)` with the resolved root. The `sw.js` and `index.html` headers are unchanged (`public, max-age=0`; SPA fallback `no-cache`). A request resolves the pointer once, so `sw.js` and `index.html` of one response come from the same release. Two requests that straddle a publication can still mix releases, as before.

**Tests.** `packages/pwa/build/atomic-output.test.ts` (13): release ids, copy and pointer, retry on EPERM, pointer stuck (old pointer kept, new folder removed), copy stuck, prune stuck (warning, then removed by the next publication), publish-never-throws. `packages/daemon/test/pwa-root.test.ts` (9) and `pwa-static.test.ts` (7): fallback to `pwa/`, pointer switch without restart, pointer removed, invalid or incomplete release, out-of-tree name, encoded `..`, cache headers.

**Activation.** A running vite watch process keeps the plugin it loaded at start. The daemon changes apply only after a daemon reload, and the plugin change only after the pwa-vite process restarts. Order: the daemon reloads first (automatic when idle, see "Extra (04/11) — reload do build"), then pwa-vite restarts. Until then the old path keeps running: the old plugin still writes `dist`, and the daemon serves `dist` because no pointer exists.

**Known limits.** The process holding the handle that caused the incident was not identified. The test suite never references `packages/pwa/dist` (every harness uses a temp `pwa/`), so tests are not the holder. Not checked on a real iPhone.

**Incident (04/11, 16:47–16:51Z): releases without CSS.** Three releases were published with an incomplete folder. The served `index.html` referenced `assets/index-CZAUDyqn.css`, and the release had no CSS file. From `supervisor.log` and the vite sources (`node_modules/vite/dist/node/chunks/node.js`, `node_modules/vite-plugin-pwa/dist/index.js`):
- Each watch cycle has two output writes. The second one has no `build started` line and empties the output folder (`emptyOutDir`). It does not re-emit unchanged CSS, but its `index.html` still references it. What triggers the second write is not established.
- Vite calls `event.result.close()` (which runs `closeBundle`) without awaiting it, and it logs `built in` before that. Our `closeBundle` therefore ran once per write, and it ran while the folder was being rewritten.
- The service-worker sub-build (`buildSW`) gets no plugins: `injectManifest.buildPlugins` is not set, so `atomicWatchOutput` never runs inside it.

**Fix (validation and debounce).**
- `build/release-check.ts` (`releaseProblems`): a folder is complete when `index.html` exists, `sw.js` has a precache list, and every local file that `index.html` (`src`, `href`), the precache list and the manifest icons reference exists. The staging folder is checked before the copy. After the copy, the folder fingerprint (names, sizes, mtimes) must equal the staging one, and the copy is checked again. Any failure removes the new folder, leaves the pointer alone, and logs the missing files (`PWA não publicado: build incompleto, faltam: ...`).
- `createWatchPublisher`: each build output restarts a 1.5 s debounce (`PUBLISH_DEBOUNCE_MS`). A build start cancels the pending publication. A failed build (`closeBundle(error)`) schedules nothing. The publication runs through `createCoalescedRunner`, so only one runs at a time.
- `packages/daemon/src/pwa-root.ts` (`missingReleaseFiles`): a release is served only if its `index.html` exists and every local `src` or `href` in it exists. The result is cached per release folder, once that folder exists. A rejected release keeps the last good one (or `pwa/`) and warns with the missing paths. The rule mirrors `releaseProblems` for `index.html`; change both together.
- e2e: the e2e daemons read the same pointer (`packages/daemon/src/main.ts` hard-codes `releases/current.json`). No e2e change is needed: a half-written release is rejected by the daemon, which then serves the last good release or `dist`.

**Tests.** `packages/pwa/build/release-check.test.ts` (14), `packages/pwa/build/atomic-output.test.ts` (staging and copy validation, fingerprint change during copy, debounce, buildStart cancels, failed build, coalesced runner, integration with disk), `packages/daemon/test/pwa-root.test.ts` (+4: missing CSS, complete release, incomplete keeps last good, one check per release), `packages/daemon/test/pwa-static.test.ts` (+1: incomplete release not served over HTTP).

**Activation.** The daemon guard loads on the automatic daemon reload. The new publisher loads only when the `vite build --watch` process restarts. Until then the old plugin runs without these checks. Meanwhile `releases/current.json` is read-only (`attrib +R`), so the old plugin cannot move the pointer. After the restart, clear it with `attrib -R`.

## Extra (04/11) — branches e arquivos do workspace

Request (04/11): the PWA gets a branch switcher for a workspace and an IDE-like file editor. This section is the daemon contract. Everything here is behind the same Bearer, Host and Origin checks as the other `/api` routes. The PWA is a separate change.

Heading language: the section title follows the maintainer's request; the body is in English as `AGENTS.md` asks for new documentation.

**Paths.** Every `path` is relative to the workspace root. Separators `/` or `\` are both accepted; the response always uses `/`. The root is `""` (listing only).
1. Strings longer than 1024 characters, NUL or other control characters, absolute paths (leading slash or backslash, drive letter, UNC) → 400 `invalid_path`.
2. Segments are split on `/` and `\`; `.` and empty segments are dropped; `..` pops one segment. A `..` that leaves the root → 403 `outside_workspace`.
3. Each segment: no `:` (alternate data streams and drive-relative names), no `<>"|?*`, no trailing dot or space, not a DOS device name (`CON PRN AUX NUL COM0-9 LPT0-9`, with or without extension), not `.git` (case-insensitive), not the 8.3 short name `GIT~n`. Failure → 400 `invalid_path`.
4. Existing targets: `realpath` must stay inside the realpath of the workspace root (symlinks and junctions that point out → 403 `outside_workspace`). The real path is checked with rule 3 too, so a link into `.git` → 400 `invalid_path`.
5. Creates, writes, mkdir and rename: the parent directory is checked with rule 4; the last segment is not followed. Delete and rename act on the entry itself, so removing a link removes only the link.

**Branches.**
- `GET /api/workspaces/:id/git/branches` → `{ isRepo: true, current, detachedAt, branches: [{ name, current, upstream, lastCommitAt }], dirty }`, or `{ isRepo: false }` for a folder that is not a repository (200, see "Extra (05/11) — branches em pasta sem git"). Earlier text below describes the `isRepo: true` case. `current` is the branch name, or null when HEAD is detached. `detachedAt` is the abbreviated commit HEAD points to when detached, else null. `branches` lists local branches, most recent commit first; `lastCommitAt` is the committer date in epoch ms. `dirty` is the path list from `git status --porcelain` (untracked included, ignored excluded), capped at 200. Paths are relative to the repository root, which differs from the workspace folder when the workspace is a subfolder of a repo; the check covers the whole repo, as `git switch` does. Errors: 404 `not_found`. A folder that is not a repository is no longer an error here (`isRepo: false`); `POST git/checkout` still answers 400 `not_a_git_repo`.
- `POST /api/workspaces/:id/git/checkout` with body `{ branch, create? }` → 200 with the same payload as GET. The name goes through `git check-ref-format --branch` and is also refused when it starts with `-` or contains `@{`; failure → 400 `invalid_branch`. Refusals in order:
  - 409 `sessions_running`: any session of the workspace (worktree sessions included) is `starting`, `running` or `awaiting_permission`.
  - 409 `dirty_worktree` with `details: { dirty }` (same list as GET).
  - `create: true` runs `git switch -c`; an existing branch → 409 `branch_exists`. Otherwise `git switch --no-guess`; a missing local branch → 404 `branch_not_found` (no remote-tracking DWIM).
  - git refuses because the branch is checked out in another worktree → 409 `branch_in_use`.
- Worktrees: the workspace folder is the checkout target. A session worktree (`nanachi/<id>` in `<NANACHI_HOME>/worktrees`) is not switched by these routes. Its branch shows in the list and cannot be checked out here while that worktree exists.

**Files.**
- `GET /api/workspaces/:id/fs/list?path=` → `{ entries: [{ name, type: "dir"|"file"|"symlink", size, mtimeMs, ignored }] }`. Directories first, then by name. `.git` is hidden. Symlinks are listed, never followed. `ignored` comes from one `git check-ignore --stdin -z` batch when the workspace is a git repo; otherwise every entry is `false`. Listing a file → 400 `not_a_directory`.
- `GET /api/workspaces/:id/fs/file?path=` → `{ path, content, encoding: "utf8", size, mtimeMs, etag }`. The content is returned as stored (line endings and BOM included). Errors: 415 `binary_file` (NUL in the first 8 KiB, or bytes that are not valid UTF-8, so a Windows-1252 file is never rewritten lossy), 413 `file_too_large` (over 2 MiB), 400 `not_a_file`, 404 `not_found`.
- `PUT /api/workspaces/:id/fs/file` with `{ path, content, baseEtag }` → `{ path, size, mtimeMs, etag }`.
  - `baseEtag: null` creates the file. An existing file → 409 `file_exists`. The parent must exist (404 `not_found`).
  - `baseEtag: string` updates. A missing file → 404 `not_found`. A different etag → 409 `file_changed` with `details: { etag: <current> }`.
  - Line endings: the content's CRLF/LF are converted to the original's style (CRLF when the original has more CRLF than bare LF, LF otherwise). A new file keeps the content as sent.
  - `content` over 2 MiB in UTF-8 → 413 `file_too_large`.
  - Atomic write: a temp file `.<name>.<uuid>.tmp` in the same folder, then rename over the target. The etag check and the rename are two steps; Windows has no compare-and-swap rename, so a write landing between them can be overwritten.
- `POST /api/workspaces/:id/fs/mkdir` `{ path }` → 201 `{ path }`. Non-recursive: the parent must exist. Existing target → 409 `already_exists`.
- `POST /api/workspaces/:id/fs/rename` `{ from, to }` → 200 `{ from, to }`. `from` must exist (404). An existing `to` → 409 `already_exists` (a case-only rename of the same entry is allowed). Moving a folder into itself → 400 `invalid_path`.
- `DELETE /api/workspaces/:id/fs/entry?path=` → 204. Files, links and empty folders only; a non-empty folder → 409 `dir_not_empty`. Never recursive. The workspace root cannot be deleted (400 `invalid_path`).
- Write rate: at most 120 PUT/mkdir/rename/delete calls per device per minute; more → 429 `too_many_writes`.

**Error codes added.** `not_a_git_repo` 400, `invalid_branch` 400, `not_a_file` 400, `not_a_directory` 400 (already used by `/api/fs`), `invalid_path` 400, `outside_workspace` 403, `not_found` 404, `branch_not_found` 404, `sessions_running` 409, `dirty_worktree` 409, `branch_exists` 409, `branch_in_use` 409, `file_exists` 409, `file_changed` 409, `already_exists` 409, `dir_not_empty` 409, `binary_file` 415, `file_too_large` 413, `too_many_writes` 429. The error body is `{ error, details? }` (`ErrorResponseSchema` in shared).

**Tests.** `packages/daemon/test/git-branches.test.ts` (temp repo: list, detached HEAD, create, switch, dirty refusal, running-session refusal, invalid names, branch checked out in another worktree). `packages/daemon/test/workspace-fs.test.ts` (list, read, write, create, rename, delete, binary, too large, etag conflict, CRLF preservation, rate limit). `packages/daemon/test/workspace-paths.test.ts` (path-escape table: `..`, absolute paths, symlink and junction out, `.git` and `GIT~1`, ADS, reserved names, NUL, control characters). Shared schemas are covered in `packages/shared/test/http.test.ts`; the write limiter in `packages/daemon/test/rate-limit.test.ts`.

**Known limits.** Hard links to files outside the workspace are not detected (reads follow the directory entry, and the content is readable). The check and the open are not atomic, so a local process that swaps a path between them can still escape. The write rate limit is per process and resets on daemon reload.

## Extra (04/11) — subagentes e segundo plano (fase 1)

**Goal.** Show background work and subagents in the chat. Phase 1 is protocol and data only: the daemon maps what each ACP agent already sends; the PWA comes later. Plain ACP v1 client, no SDK change. No behaviour change for existing clients: the new fields are optional and absent when there is nothing to report.

**Schema (`packages/shared/src/session.ts`).** `tool_call` and `tool_call_update` gain three optional fields:
- `parentToolCallId?: string`: the `toolCallId` of the tool call that made this one (Claude `_meta.claudeCode.parentToolUseId`). Chains: a child of a child names its direct parent.
- `toolName?: string`: Claude `_meta.claudeCode.toolName` (`Agent`, `Task`, `Bash`, ...); an update without it reuses the name the daemon remembers for that call. Codex and omp do not send it in phase 1; their tool name is the title.
- `background?: { kind: 'subagent'|'shell'|'job', state: 'running'|'completed'|'failed'|'stopped'|'unknown', label?, agentType?, jobs?: { id, label?, status }[] }`. Limits: label 200 characters, `jobs` 50 items, job `status` 40 characters (a longer status becomes `unknown`). Ids over 200 characters are not used as references (`parentToolCallId`, `toolName`, job `id`).

Stored events hold only these fields. `rawInput` and `rawOutput` are never stored. Old rows without the fields parse as before.

**Consumer rule.** Each `tool_call`/`tool_call_update` carries the full `background` of its tool call as known at that point: the latest event for a `toolCallId` wins. Jobs are keyed by `id`; a later job entry with the same `id` replaces the earlier one. The daemon never writes an extra event for the end of a turn. A consumer that sees `state: "running"` for a background item, followed by a `turn_end` in the same session, shows it as ended with an unknown result. This covers async launches (see below), whose real end the adapters do not send.

**Derivation (`packages/daemon/src/tool-background.ts`, pure).** Status of a tool call: ACP `pending`/`in_progress` → running; `completed` → the rule below; `failed` → failed; absent → the state already known for that `toolCallId`, or running.

Status words of jobs (Codex agent states and omp job states), one table for both: running = `pending`, `queued`, `running`, `in_progress`, `pendingInit`; failed = `failed`, `error`, `errored`, `notFound`; stopped = `cancelled`, `canceled`, `aborted`, `interrupted`, `shutdown`; completed = `completed`, `done`; anything else = unknown (does not count as running).

Aggregate of a call that completed: any job running → running; any job failed → failed; all jobs stopped → stopped; otherwise completed. A call with no jobs that completed → completed.

- **Claude `Agent` / `Task`** → `kind: "subagent"`, label = `rawInput.description`, `agentType` = `rawInput.subagent_type` (both trimmed; empty is omitted). A completed call whose result text matches `/async agent launched/i` stays `running` (async). Failed → `failed`. A sync completed call → `completed`.
- **Claude `Bash`** with `rawInput.run_in_background === true`, or a result text matching `/running in background/i`, or a call already known as shell → `kind: "shell"`, label = `rawInput.description`. State: failed → `failed`; otherwise `running` (until the turn end, see the consumer rule).
- **Codex** `spawnAgent`, `resumeAgent`, `sendInput`, `followupTask` → `kind: "subagent"`. Codex `wait` only when `rawInput.receiverThreadIds` is an array or `rawInput.agentsStates` is an object (the omp `wait` has no such field). An update with no title but that same `rawInput` shape is also Codex. Jobs: the `receiverThreadIds` plus the keys of `agentsStates`, status = `agentsStates[id].status` (`unknown` when missing). Label = the codex title.
- **omp `task`** (`rawInput.tasks` is an array) or a tool result with `details.async`, `details.progress`, `details.results` or `details.jobs` → `kind: "job"`, label = the title. Jobs: `details.async` → `{id: jobId, status: state}`; `details.progress[]` → `{id, label: task, status}`; `details.results[]` → `{id, status: status or "completed"}`; `details.jobs[]` (omp `wait`) → `{id, status}`. `resultText` is not stored. `details.async.state` in a call that completed counts as a job, so an async launch stays `running`.

Labels are cut to 200 characters with a code-point-safe cut, and empty strings are omitted. Jobs are capped at 50 (first 50 kept).

**Where the state is kept.** `SessionManager` keeps a map `toolCallId → { toolName?, background? }` per live session (`LiveSession.toolCalls`). An entry is written only when a tool call has a `background`, so later updates of that call can keep its label, `agentType` and job list. The map is filled by live updates and by the history replay of an import. It is not filled by the replay of a normal resume (it is discarded there), and it is lost on a daemon reload: an update that arrives after a reload for a call started before it carries the fields it has, without the label. Known limit.

**Serialization.** Events are stored as JSON in `events.payload` (`repository.ts` `insertEvent`) and read back through `listEvents`, which parses with `SessionEventSchema`. `GET /api/sessions/:id/events`, the WS `subscribe` replay and the live `event` message all use that path, so they carry the fields without changes. Zod strips unknown keys, so the schema change is what lets them through.

**Tests.** `packages/daemon/test/tool-background.test.ts`: table tests per agent shape (fixtures with synthetic ids and text), the status table, the caps and the memory rules. `packages/daemon/test/acp-mapping.test.ts`: `sessionUpdateToDraft` on the same fixtures. `packages/shared/test/session.test.ts`: an event without the new fields parses unchanged; new fields accepted; limits enforced. Replay: `packages/daemon/test/replay.test.ts` ("replay de eventos com background"): stored rows with the new fields come back the same from `replayEvents` and from `listEvents` (the events GET); an old row has no new keys. Not covered: a live turn through the fake agent (the `handleUpdate` path that passes `LiveSession.toolCalls`); it is type-checked, not exercised.

**Open questions (need a live prompt).** Real `_meta.claudeCode.toolName` and the exact async-launch text in Claude Code 0.100; whether `rawInput` is present on Codex updates (not only on the first `tool_call`); the omp `task`/`wait` tool names and the `details.results[]` item shape. Until a live run confirms them, these are the shapes from reading the installed adapters, not from captured traffic.

## Extra (05/11) — modo Loop

Request (05/11, pt-BR): a Loop mode in the chat. The user turns it on, sets a prompt, and Nanachi repeats it, like `/loop` in Claude Code and Oh My Pi. Claude Code's `/loop [interval] [prompt]` runs a prompt or slash command on an interval; with no interval the model paces itself; it runs until stopped; an iteration never overlaps a running turn. Oh My Pi does not announce `/loop` over ACP (checked: absent from its 83 commands), so the loop lives in the **daemon**, for every ACP agent. It also runs with the phone closed and survives a daemon reload.

Decisions (the maintainer delegated them):
- **Interval is measured from the end of the turn.** The next run is `intervalMs` after the previous iteration's `turn_end`. I could not confirm how Claude Code measures it, so this is the choice; it means a long turn stretches the period, and no catch-up burst happens.
- **Dynamic mode** asks the agent for a marker (below). Claude Code's own `/loop` is the reference for the behaviour, not for the marker: the marker is Nanachi's protocol.
- **Claude.** Nanachi's loop is the default for Claude sessions too. The PWA's sheet offers "Usar /loop nativo do Claude", which sends `/loop ...` as a normal prompt. The daemon does not know the difference: it only sees a prompt.

### Model (migration 7, table `loops`)

`loops(session_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('interval','dynamic')), interval_ms INTEGER NULL, max_iterations INTEGER NULL, iterations INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK (state IN ('active','paused','stopped')), next_run_at INTEGER NULL, last_run_at INTEGER NULL, last_error TEXT NULL, created_at INTEGER NOT NULL)`. One loop per session. Deleted with the session rows (`deleteSessionRows`).

shared (`packages/shared/src/loop.ts`):
- `LOOP_INTERVAL_MIN_MS = 30_000`, `LOOP_INTERVAL_MAX_MS = 86_400_000`, `LOOP_DYNAMIC_DEFAULT_MS = 600_000`, `LOOP_PROMPT_MAX = 10_000` characters.
- `Loop = { sessionId, prompt, mode: 'interval'|'dynamic', intervalMs: number|null, maxIterations: number|null, iterations, state: 'active'|'paused'|'stopped', nextRunAt: number|null, lastRunAt: number|null, lastError: string|null, createdAt }`. Nullable fields are always present (no optional keys).
- `LoopRequest = { prompt, mode, intervalMs?, maxIterations?, runNow?: boolean (default true) }`. `mode: 'interval'` requires `intervalMs` in range; `mode: 'dynamic'` rejects `intervalMs`. `maxIterations` ≥ 1 when present.
- `parseLoopDuration("90s" | "10m" | "2h" | "1h30m") → ms | undefined` (no range check, no spaces, case-insensitive).
- `parseLoopArgs(input) → { intervalMs: number | undefined, prompt: string } | undefined`. The first whitespace-separated token is an interval when it parses as a duration; then the prompt is the rest. Without an interval token, `intervalMs` is undefined (dynamic). Returns undefined when the prompt is empty, or when the interval token is out of range (`5s`, `25h`) or has no prompt after it. A token that is not a duration (`1d`) is part of the prompt.

### Scheduling (`packages/daemon/src/loop-runner.ts`)

- **Interval mode:** the next run is at `turn_end + intervalMs`. A loop created with `runNow: false` runs at `now + intervalMs`.
- **Dynamic mode:** the next run is at `turn_end + delay`, where `delay` comes from the last well-formed marker in that turn's agent text (`[[nanachi-loop-next: <duration>]]`), clamped to 30 s–24 h. No marker: 10 min (`LOOP_DYNAMIC_DEFAULT_MS`). A `[[nanachi-loop-stop]]` marker, the last one in the turn, ends the loop (`stopped`). Malformed markers (e.g. the `<duração>` placeholder of the instruction, echoed back) are ignored. Parser: `parseLoopMarker(text)` in `loop-runner.ts`, pure, tested.
- **Dynamic instruction.** The iteration's ACP prompt gets one more text block after the user's text, in Portuguese, saying how to end the reply. When the phone-send hint also applies, both share that block, the hint first. The stored `user_message` does not show it, like the phone-send hint. A slash command (`/foo ...`) gets no instruction: it would become the command's argument. Such an iteration uses the 10 min default, and cannot stop itself.
- **No overlap.** A timer fires only when the loop has no iteration in flight. If the session is `starting`, `running` or `awaiting_permission` when the timer fires, the loop waits (nothing is queued) and runs when the session goes `idle` (or `error`). The status notice is the fast path; a recheck every `LOOP_BUSY_RECHECK_MS` (2 s) covers a status change that does not pass through it, so a waiting round cannot stay queued for good. Exactly one pending iteration at most, by construction.
- **Stopped or error session.** The iteration calls the same path as a prompt, so a stopped or error session is resumed first (`ensureLive`). If the resume fails, the loop is paused with `lastError` and sends the loop push below.
- **Iteration failure:** a rejected turn, a failed start (for example a resume that fails), or `stopReason: "error"` (not in ACP v1; handled defensively), pauses the loop with `lastError`. Every such pause sends a Web Push through `onNotify` with kind `loop_paused`: title `Loop pausado`, body `<session title>: <lastError>` (120 characters max), workspace mute respected. The push shares the session's notification `tag`, so on the phone it replaces the session's `error` push instead of stacking on it. The `error` event is still written to the chat. `stopReason: "cancelled"` (the user pressed Parar) pauses the loop without `lastError` and without a push. Other stop reasons keep the loop running.
- **Counting.** `iterations` grows when an iteration is sent (persisted before the send, reverted if the send fails). `maxIterations` reached after a turn → `stopped`.
- **Each iteration** writes a `user_message` with `loop: true` and `loopIteration: <n>` (shared schema, optional fields). The phone-send hint rules do not change.
- **Reload.** A pending loop does not count as busy: `countBusySessions` only counts real `starting`/`running`/`awaiting_permission`. On start, active loops are restored from the table. `nextRunAt` in the past, or `null` (the daemon stopped mid-iteration), runs 5 s after start; a future `nextRunAt` keeps its time. The reload-resume and the loop share one resume per session (`resumeOnce`).
- **Ending.** `DELETE /loop` (and `stop` of the session, workspace deletion) stops the loop: a session that the user stopped is not resumed by its own loop. The daemon restart does not stop a loop (`stopInterruptedSessions` only changes sessions). Removing the session (`forget`) deletes the row. An iteration already running is not cancelled by `DELETE`: the agent's turn ends, and no further one is scheduled (the user's Parar stops the turn).
- `pause` while a turn runs: the turn finishes; nothing is scheduled. `resume` (paused → active): `nextRunAt = now`, runs when the session is idle. `run-now` runs one iteration now and keeps the state (a paused loop stays paused).

### API (Bearer, same guards as the other session routes)

- `GET /api/sessions/:id/loop` → `{ loop: Loop | null }` (`LoopResponseSchema`). 404 if the session does not exist.
- `PUT /api/sessions/:id/loop` with `LoopRequest` → 200 `{ loop }`. Creates or replaces the loop and starts it. `runNow` (default true) runs the first iteration now; the response does not wait for the turn. Bad body → 400 `invalid_request`. Session of a PTY kind → 409 `not_acp`. An iteration in flight → 409 `loop_busy` (replace after it ends).
- `POST /api/sessions/:id/loop/pause` → 200 `{ loop }`. Active → paused.
- `POST /api/sessions/:id/loop/resume` → 200 `{ loop }`. Paused → active (`nextRunAt = now`). Stopped → 409 `loop_finished` (PUT again).
- `POST /api/sessions/:id/loop/run-now` → 200 `{ loop }`. Stopped → 409 `loop_finished`; in flight → 409 `loop_busy`.
- `DELETE /api/sessions/:id/loop` → 204 (stops and deletes). No loop → 404 `loop_not_found` (same for pause, resume, run-now).

### WebSocket

ServerMessage `loop { sessionId, loop: Loop | null }`, sent only to the clients subscribed to the session: on `subscribe` (always, after the replay, `null` included) and on each change. Not sent during the replay. The PWA learns of changes from it and reads the first state with the GET.

**Snapshot order (`revision`).** Every `Loop` carries `revision`, a number the daemon gives each snapshot it publishes or reads: `max(Date.now(), previous + 1)` per loop, kept in memory. The PWA's `pickLoop` keeps the snapshot with the higher revision, so an HTTP reply to an action (pause, resume, run-now) that arrives after a newer WS `loop` message cannot bring back a stale state. Before this, a reply could leave the chip on "Rodando agora" or "Na fila" until the next change. A `null` (loop deleted) always applies. The counter restarts with the daemon process; a new process starts above the wall clock, so a later snapshot still has the higher revision.

### Tests

- `packages/shared/test/loop.test.ts`: duration grammar, `parseLoopArgs` (`5m /foo bar`, `30s`, `2h`, `1h30m`, dynamic, out of range, empty), request schema rules.
- `packages/daemon/test/loop-runner.test.ts` (fake timers, a fake host; no agent): interval after the turn end, no overlap while busy, marker parsing and clamping, stop marker, `maxIterations`, failure pauses with `lastError`, cancelled pauses, restore of past/null/future `nextRunAt`.
- `packages/daemon/test/loop-routes.test.ts` (fake agent, real timers, `runNow`): routes, WS `loop` on subscribe and on change, `user_message` with `loop`, error pauses and pushes, resume of a stopped session, delete on session removal, reload persistence (a second daemon on the same home restores the loop).

Known limits: the instruction is not appended to slash-command iterations (see above); a crash in the middle of an iteration counts it and the next one starts after the restart; `loop-runner` state is per process and resets on reload, but the table does not. Not checked against real `claude`, `omp` or `codex`.

## Extra (05/11) — terminal no workspace e entrar com Tailscale

Request (05/11, pt-BR): (1) remove the self-edit route, since the user removed the feature; (2) "criar um terminal na pasta do workspace e mexer igual no pc": an interactive shell in the workspace folder that reuses the PTY path of `agy`; (3) "entrar com Tailscale": reconnect from the phone when away from the PC, without a pairing code; (4) investigate the token loss on iOS (report only, no PWA change).

### 1. `GET /api/self` removed

The route, `packages/daemon/src/self.ts`, `self.test.ts` and `SelfResponseSchema` (shared) are deleted. Nothing else used them. The section "Edit Nanachi from Nanachi" above is kept as history.

### 2. Shell sessions (`agent: "shell"`)

Decision: a shell is a session with `agent: "shell"` and `kind: "pty"`, not a new route. The lifecycle (list, delete, `forget`, the WS `subscribe`, `terminal_input`, `terminal_resize`, the `terminal_output` replay) and the PWA's TerminalScreen are already keyed on `kind: "pty"`.

Contract:
- `POST /api/sessions { workspaceId, agent: "shell", shell?: "powershell" | "pwsh" | "cmd" | "bash", worktree? }` → 201 `Session`: `agent: "shell"`, `kind: "pty"`, title `Terminal · <shell>`, status `running` once the PTY is up. `shell` with another agent → 400 `invalid_request`. `resumeAcpSessionId` with a shell → 400 `invalid_request`.
- `GET /api/shells` → `{ shells: { id, label, isDefault }[] }`: only the shells found on this PC. Empty when `shellSessions` is false.
- Detection (`shells.ts`; pure, with the file probe injected): `pwsh.exe` on PATH; `powershell.exe` on PATH or in `%SystemRoot%\System32\WindowsPowerShell\v1.0`; `cmd.exe` from `ComSpec`, then `System32`; `bash.exe` only from Git for Windows (`Git\bin\bash.exe` under `ProgramFiles`, `ProgramFiles(x86)` or `LOCALAPPDATA\Programs`, or next to the `git.exe` on PATH). `System32\bash.exe` (the WSL launcher) is never used. Default: `pwsh`, else `powershell`, else `cmd`.
- Requested shell not found (or no default exists) → 400 `shell_unavailable`.
- cwd: the workspace path, or the worktree path when `worktree: true` (same rule as agent sessions).
- Arguments: `powershell`/`pwsh` `-NoLogo`; `bash` `--login -i`; `cmd` none. Terminal size starts at 80x24; the PWA sends `terminal_resize`.
- Environment: the daemon's environment without any `NANACHI_*` variable. A shell gets no agent token, no `NANACHI_URL` and no phone-send `PATH` entry (phone-send needs a session token that a shell does not have). `agents.*.env` from the config is not applied.
- Stop → `taskkill /T /F` on the whole tree (the existing `killProcessTree`). Shell exits → `terminal_exit { exitCode }` and status `stopped`.
- Not resumable: `POST /resume` → 409 `not_resumable`; a prompt to a stopped shell → `not_resumable` with the message "sessão encerrada e não pode ser retomada; crie uma nova" (the "retomar ao enviar" path skips shells); `PUT /loop` → 409 `not_acp`; `POST /usage` → 400 `usage_unsupported`. Reload-resume only saves ACP sessions, so it never picks a shell.
- Errors: 403 `shell_disabled` (`shellSessions: false`); 403 `outside_roots` (the workspace path must be inside `allowedRoots`, checked on every creation, not only when the workspace was registered); 400 `shell_unavailable`; 409 `too_many_sessions` (shells count toward the 8 live sessions).

Supervisor reload:
- A shell does NOT block the reload: `countBusySessions` excludes `agent = 'shell'`, so a shell that stays open does not hold the reload forever. Trade-off: a command still running in a shell is interrupted by the reload. Blocking while a command runs would need output-based idle detection; not done (open question for the maintainer).
- Before the reload kills the shell, every live shell gets a persisted event `terminal_exit { exitCode: null, reason: "reload" }` and status `stopped`. It reaches the subscribers like any event, but it does NOT send Web Push (`notify: false`). The PWA shows "terminal encerrado pelo recarregamento do Nanachi" when `reason === "reload"`.
- A daemon restart that is not a reload (crash, manual) marks running shells `stopped` through `stopInterruptedSessions`, without that event.

Security:
- Same Bearer auth as every `/api` route, and the Tailscale allowlist applies. A shell is a full shell as the Windows user, which the user asked for. `shellSessions: false` in `config.json` turns the feature off (default `true`).
- Workspace inside `allowedRoots` (re-checked on creation). Shell environment without `NANACHI_*` (no daemon or agent tokens).

Tests: shared (shell and config schemas, `terminal_exit.reason`, device push payload); daemon `shells` (detection with a fake probe: default, `bash` never from WSL, env stripping); daemon `shell-sessions` (real `cmd` PTY, skipped when node-pty cannot spawn): create, write, read output, resize, exit, stop, not resumable (resume, prompt, loop, usage), shell list, `shellSessions: false`, workspace outside roots, reload notice without push, shell not counted as busy.

### 3. "Entrar com Tailscale" (pairing without a code)

- Config `tailscaleAutoPair` (default `false`). The daemon reads `config.json` once at startup, so the value applies when the daemon restarts (the supervisor's reload does it after a build).
- Trusted login = the peer address is loopback AND the header `Tailscale-User-Login` is present. The global allowlist check and the new route use this same function (`tailscale-login.ts`). Before this change the allowlist check trusted the header without looking at the peer; the listen host is loopback-only (`ConfigSchema.host`), so production does not change.
- `GET /api/pair/tailscale` (no Bearer) → `{ available: boolean, login?: string }`. `available` is true only when `tailscaleAutoPair` is on AND the trusted login is in `allowedTailscaleLogins`. `login` appears only when `available` is true. This route is exempt from the global allowlist hook, so it can answer `available: false` for an unlisted login instead of a 403.
- `POST /api/pair/tailscale` (no Bearer) body `{ deviceName }` (1..64 chars) → 200 `PairResponse`, the same schema as code pairing. Not available → 403 `pair_unavailable`. Invalid body → 400 `invalid_body`.
- Rate limit: the same failure limiter as code pairing, with the same key (the login, or the IP without one). A 403 or an invalid body counts as a failure; 5 in 60 s → 429 `too_many_attempts`.
- Record: migration 8 adds `devices.pair_method` (`'code' | 'tailscale'`, default `'code'`). The value is stored only; `GET /api/devices` does not expose it yet.
- Web Push after a successful pairing: "Novo aparelho entrou com Tailscale: <deviceName>" to every other device that has a push subscription, whether or not its WS is open (the app does not show pairing events, so an open app would miss it). Payload `DevicePairedPushPayloadSchema` (shared, `push.ts`): `{ title: "Nanachi Remote", body, machineId, kind: "device_paired" }`. It has no session fields, so the PWA's `PushPayloadSchema` does not accept it: the PWA needs a handler for it. A failed push never fails the pairing.

Tests: shared (`TailscalePairStatusResponseSchema`, `TailscalePairRequestSchema`, `DevicePairedPushPayloadSchema`, config defaults); daemon `tailscale-login` (peer address, header, loopback forms); daemon `pair-tailscale` (availability matrix: flag off, header missing, header not in the allowlist, non-loopback peer with a valid header; success with `pair_method`; 403; 400; the rate limit; the push to the other devices and not to the new one; a push that fails does not fail the pairing).

### 4. Token loss on iOS (report only)

No code change. The findings are in the task report; the mitigation is for the PWA agent (see "PWA follow-ups" below).

PWA follow-ups (not done here, the PWA agent owns `packages/pwa/src`):
- New-session sheet: list `GET /api/shells` and send `agent: "shell"` with the chosen `shell`; show the terminal title.
- Terminal screen: when `terminal_exit.reason === "reload"`, show "terminal encerrado pelo recarregamento do Nanachi".
- Push: handle `kind: "device_paired"` (no session target; open the app on click).
- Settings/pairing screen: "Entrar com Tailscale" button that calls `GET /api/pair/tailscale`, shows the button only when `available`, then `POST /api/pair/tailscale`.

## Extra (05/11) — branches em pasta sem git

Problem: the branch chip asked `git/branches` on every workspace. A plain folder answered 400 `not_a_git_repo`, so the console logged an error for each open and `e2e:commands` failed on it.

Contract (shared `http.ts`): `GitBranchesResponseSchema` is a discriminated union on `isRepo`. `{ isRepo: true, current, detachedAt, branches, dirty }` (`GitBranchesRepoSchema`) or `{ isRepo: false }` (`GitBranchesNotRepoSchema`). `GET /api/workspaces/:id/git/branches` answers 200 with the second form for a non-repository. `POST /api/workspaces/:id/git/checkout` still checks the repository first and answers 400 `not_a_git_repo`; its reply is always the repository form (`GitBranchesRepoSchema`).

PWA: `BranchSwitcher` renders nothing when `isRepo` is false (no chip, no console error). `gitCheckout` returns `GitBranchesRepo`.

Tests: shared `http.test.ts` (union, `isRepo` required); daemon `git-branches.test.ts` (plain folder → 200 `{ isRepo: false }`; checkout → 400); PWA `apiWorkspace.test.ts` (client accepts the non-repo reply; checkout keeps 400).

## Extra (05/11) — rolagem por toque no terminal

Problem (reported from the iPhone): the terminal does not scroll with a finger. xterm.js 6 has a touch handler, but on iOS it does not scroll the scrollback in practice.

Behaviour (`packages/pwa/src/terminal/attachTouchScroll.ts`, wired in `useTerminal.ts`):
- A one-finger drag on the terminal area on the vertical axis scrolls the buffer by `term.scrollLines(n)`. `n` comes from the pixels moved divided by the cell height (`lineStep` keeps the remainder between moves). Dragging the finger down shows older output.
- On release, the scroll continues with momentum: the velocity comes from the last 100 ms of samples (`flingVelocity`), each frame moves `velocity × dt` and loses velocity by a factor of 0.95 per 16 ms frame. It stops below 0.02 px/ms (`flingStep`, `isFlingOver`).
- With an app that enabled mouse tracking (`term.modes.mouseTrackingMode !== 'none'`, for example vim or less with mouse), the same lines become wheel events dispatched on the xterm screen element. xterm encodes them for the app. The encoding is xterm's, not checked against a real vim session.
- A drag on the horizontal axis does not scroll (`gestureAxis`). A touch without movement (under 8 px, `TAP_SLOP_PX`) is not captured: the click follows and the terminal takes focus, which opens the keyboard on the iPhone.
- The listeners sit in the capture phase on the terminal element and stop the event when the drag is vertical, so xterm's own touch handler does not scroll a second time. The element gets `touch-action: none` and `overscroll-behavior: contain` while the terminal is mounted: no page bounce from the terminal area.
- A "Ir para o fim" button (`data-slot="terminal-scroll-end"`) appears while the output is scrolled up (`viewportY < baseY`) and scrolls to the end. It sits outside the xterm element, like the chat's button.

Tests: `packages/pwa/src/terminal/touchScroll.test.ts` (axis, line steps with carry, velocity window, momentum decay). `e2e/run-terminal.mjs` (`stepTouchScroll`): 120 lines of output, a vertical drag through CDP `Input.dispatchTouchEvent` moves the first visible row and shows the button, a horizontal drag keeps it, a `touchscreen.tap` focuses the xterm textarea, the button returns to the end.

Not checked: the keyboard opening and the momentum feel on a real iPhone; the mouse-tracking path (no app in the e2e uses mouse tracking). The user confirms the feel on the device.

## Extra (05/11) — model provider in the model picker

Request (05/11): in the model picker of an agent with many connected providers (Oh My Pi), show exactly which provider each model comes from.

Observed (05/11, `omp acp` 18.13.2, `session/new`): one `model` select (category `model`) with 739 options in a flat list. `value` is `<provider>/<model id>`, `name` is the display name, `description` repeats `value`. Providers by first segment: `openrouter` 602, `cursor` 123, `openai-codex` 8, `claude-cli` 6. OpenRouter values have a third segment: `openrouter/~anthropic/claude-opus-latest` (the upstream vendor, sometimes with a leading `~`). 36 display names repeat across providers ("Claude Opus 5.5" exists under `cursor` and `claude-cli`). Today the picker shows only `name`, so those are indistinguishable. Claude Code values (`default`, `opus`, `sonnet[1m]`) have no `/`.

ACP also allows grouped select options (`SessionConfigSelectGroup = { group, name, options }`, SDK `v1/schema/types.gen.d.ts`). The daemon's `toSharedOption` (acp-mapping.ts) flattens groups and drops the group name today.

Contract:
- shared `session.ts`: `SelectOptionSchema` gains `group: z.string().min(1).nullable().optional()`: the `name` of the ACP group the option came from. Absent when the agent sent a flat list.
- daemon `acp-mapping.ts` `toSharedOption`: options inside a group keep `group: <group name>`; flat options omit `group`. Nothing else changes.
- PWA pure helper `packages/pwa/src/chat/modelSource.ts`:
  - `PROVIDER_LABELS`: `openrouter` OpenRouter, `cursor` Cursor, `openai-codex` OpenAI Codex, `openai` OpenAI, `anthropic` Anthropic, `claude-cli` Claude CLI, `google` Google, `google-gemini-cli` Gemini CLI, `gemini` Gemini, `github-copilot` GitHub Copilot, `x-ai`/`xai` xAI, `mistralai`/`mistral` Mistral, `deepseek` DeepSeek, `qwen` Qwen, `z-ai`/`zai` Z.ai, `moonshotai` Moonshot AI, `meta-llama` Meta, `nvidia` NVIDIA, `minimax` MiniMax, `ollama` Ollama, `lmstudio` LM Studio, `groq` Groq, `cerebras` Cerebras, `amazon-bedrock` Amazon Bedrock, `azure-openai` Azure OpenAI, `vertex` Vertex AI. Unknown id → the id itself.
  - `modelSourceOf(choice: { value: string; group?: string | null }): { providerId: string; providerLabel: string; vendorLabel: string | null } | null`. `group` set → `providerId = providerLabel = group`, `vendorLabel = null`. Else, `value` with at least one `/` → first segment is the provider (label from the map). With three or more segments, the second segment without a leading `~` is the vendor (label from the map); otherwise `vendorLabel = null`. No `/` and no group → `null`.
  - `providerGroups(options)`: `{ providerId, providerLabel, options }[]` in first-appearance order. Returns `undefined` when fewer than two distinct providers come out (single-provider or provider-less lists keep today's rendering). Options without a source go to a final group with label "Outros".
  - `choiceLabel(choice)`: `name`, plus ` · <vendorLabel>` when there is a vendor. Used inside a provider group.
- Where it applies: select options whose `category` is `model` (or whose `id` is `model` when `category` is null). Other selects are unchanged.
- UI:
  - `ConfigSelect` (session bar "Modelo" row) and `ConfigControls` selects: the native `<select>` gets one `<optgroup label={providerLabel}>` per provider; option text from `choiceLabel`. The closed row shows the model name and, under it in muted small text, the provider label (and vendor when present), so the current provider is visible without opening the picker. Keep the native select (the iOS wheel shows the optgroup headers): render the visible text in spans and lay the select over them transparently (`absolute inset-0 opacity-0`), keeping the existing `data-slot` attributes and focus ring.
  - The `/model` native picker (`commandSheetFor` → kind `config` → ActionSheet in ChatScreen): section header per provider group, option text from `choiceLabel`, the current value marked as today.
  - lucide icons only, no emoji. Portuguese labels as in the rest of the app.
- Tests: shared (`group` optional and nullable); daemon `acp-mapping` (grouped options keep the group name, flat ones omit it); PWA `modelSource.test.ts` (omp-style values: `openrouter/~anthropic/claude-opus-latest` → OpenRouter + Anthropic; `cursor/claude-4.5-sonnet` → Cursor; `claude-cli/opus` → Claude CLI; `default` → null; grouped option → group name; `providerGroups` order, "Outros", `undefined` for one provider and for Claude-style values).

## Extra (05/11) — rate-limit resets in the usage drawer

Request (05/11): spend saved rate-limit resets from the agent's usage interface. Never test with real resets: spending one is irreversible and uses the user's credit.

Observed (05/11):
- **omp 18.13.2** has `/usage reset` ("Spend a saved provider rate-limit reset", ACP hint `[show|reset [provider/credential-id|provider/active]]`). Providers with resets: `anthropic` (refreshes Claude's 5h session limit) and `openai-codex`.
  - `/usage reset` with no argument lists them. Reply lines:
    - `Saved rate-limit resets:`
    - one line per stored account: `- <label> [<providerLabel> · <provider>/<credentialId>]: <A> saved, <U> usable now[, expires <when>][ (<reason>)][ (active)]`, or `- <label> [<providerLabel> · <provider>/<credentialId>]: unavailable (<error>)[ (active)]`. `<label>` is `<email or account id>[ · <org>]`. `<when>` is text as omp prints it.
    - a blank line, then ``Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.``
    - No account: `No provider accounts found. Use /login to add one.` Load failure: `Could not load saved resets: <message>`.
  - `/usage reset <provider>/<credentialId|active>` spends one. One-line reply, for example `Reset applied for <label> (<providerLabel>) — <what was refreshed>.`; `<label> (<providerLabel>): that reset was already redeemed.`; `...: no saved resets available to spend...`; `...: nothing to reset right now — your covered limits aren't constrained, so no credit was spent.`; `...: couldn't load this account's saved resets (network/auth) — nothing was spent, try again.`; `Could not find the stored account ...`; `...: could not authenticate this account — try /login.`; `...: the reset offer changed — nothing was spent; reopen /usage reset.`; and validation errors (`No stored account matches ...`, `...: no saved resets usable right now...`, `...: saved resets unavailable (...), so nothing was spent.`).
- **Codex**: the app-server of `@openai/codex` 0.165.0 (the copy codex-acp 2.5 bundles and runs) has `account/rateLimits/read` and `account/rateLimitResetCredit/consume`. codex-acp does not expose them over ACP. Line-delimited JSON-RPC without the `jsonrpc` field (checked 05/11): `initialize { clientInfo: { name, title, version }, capabilities: null }`, then the notification `{ method: "initialized" }`.
  - `account/rateLimits/read {}` → `{ rateLimitResetCredits: { availableCount: number, credits: Array<{ id, resetType, status: "available"|"redeeming"|"redeemed"|"unknown", grantedAt: number (s), expiresAt: number|null (s), title: string|null, description: string|null }> | null } | null, ... }`. `credits: null` means only the count is known.
  - `account/rateLimitResetCredit/consume { idempotencyKey: string, creditId?: string|null }` → `{ outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" }`. Without `creditId` the backend picks the next credit.
  - `account/read {}` → `{ account: { type: "chatgpt", email, planType } | { type: "apiKey" } | null, requiresOpenaiAuth }` (check the generated bindings: `codex app-server generate-ts --out <dir>`).
- **Claude Code** 2.1.318 / claude-agent-acp 0.100: no reset command. Unsupported.

Contract:
- shared `http.ts`:
  - `ResetEntrySchema = { target: string (1..200), accountLabel: string, providerLabel: string | null, available: int ≥ 0, usable: int ≥ 0, expiresAt: string | null, note: string | null, active: boolean }`. `target` is opaque to the PWA and goes back unchanged on redeem.
  - `ResetsResponseSchema = { agent: string, entries: ResetEntry[], message: string | null, fetchedAt: number, cached?: true }`. `message` carries omp's "No provider accounts found..." or "Could not load saved resets..." line when there are no entries.
  - `ResetRedeemRequestSchema = { target: string (1..200) }`.
  - `ResetRedeemResponseSchema = { outcome: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed" | "failed", message: string }`.
  - Error codes `resets_unsupported` (400) and `reset_in_progress` (409) in the shared error-code list and the PWA error messages ("Este agente não tem resets salvos", "Já tem um reset em andamento").
- Routes (Bearer, same guards as `POST /api/sessions/:id/usage`, no auto-resume, never touch the session's events or status):
  - `GET /api/sessions/:id/usage/resets` → 200 `ResetsResponse`. 404 `not_found`; 400 `resets_unsupported` for any agent without a reset source (claude, agy, shell, custom ids, PTY); 502 `agent_failed`; 504 `agent_timeout`. Cached 30 s per agent kind (and per account once accounts exist) with `cached: true`, like usage.
  - `POST /api/sessions/:id/usage/resets { target }` → 200 `ResetRedeemResponse`. This spends a credit: the daemon never retries it, never sends it twice, and runs at most one redeem per agent kind (and account) at a time; a second concurrent call → 409 `reset_in_progress`. After any redeem attempt (success or not) the usage cache and the resets cache of that agent/account are dropped.
- omp source (`packages/daemon/src/usage-resets.ts`, pure parser + command builder; runs on the existing usage probe of the agent, same 30 s timeout and cancel rules as usage):
  - List: the probe sends the text prompt `/usage reset`. Parse the reply (ANSI stripped) with the line formats above into entries: `target = "<provider>/<credentialId>"`, `accountLabel = <label>`, `providerLabel = <providerLabel>`, `available = A`, `usable = U`, `expiresAt = <when>` or null, `note = <reason>` (or `unavailable` → `available = usable = 0`, `note = <error>`), `active` from the trailing `(active)`. Lines that do not match are ignored. No entries → `message` = the first non-empty line.
  - Redeem: `target` must match `^(anthropic|openai-codex)/(\d+|active)$`, else 400 `invalid_request`. The prompt is exactly `/usage reset <provider>/<credentialId>` rebuilt from the validated parts (no other user text). Outcome from the reply: contains `Reset applied` → `reset`; `already redeemed` → `already_redeemed`; `no saved resets` → `no_credit`; `nothing to reset` → `nothing_to_reset`; anything else → `failed`. `message` = the reply with ANSI stripped, trimmed, at most 500 characters.
- Codex source (`packages/daemon/src/codex-app-server.ts`): a short-lived client per operation. It spawns the bundled codex: `process.execPath` with `[<@openai/codex/bin/codex.js resolved with createRequire from @agentclientprotocol/codex-acp's package.json>, "app-server"]`; when the agent env sets `CODEX_PATH`, run that executable with `["app-server"]` instead (codex-acp's own rule). Env: the same env the codex agent gets (`agents.codex.env`, agent PATH), without `NANACHI_*`; plus the account home variable once accounts exist. No shell, `windowsHide`. It sends only `initialize`, `initialized`, `account/read`, `account/rateLimits/read` and `account/rateLimitResetCredit/consume`: never a thread or turn request. 30 s timeout for the whole operation; the process is killed when the operation ends.
  - List: one entry for the account: `accountLabel` = `account.email` from `account/read` (or "Conta"), `providerLabel` "OpenAI Codex", `available = availableCount`, `usable` = credits with status `available` (or `availableCount` when `credits` is null), `expiresAt` = soonest `expiresAt` among available credits as ISO-8601 (or null), `note` null, `active` true, `target` = that credit's `id`, or `"next"` when ids are unknown. `rateLimitResetCredits` null → no entries, `message` "Nenhum reset salvo nesta conta".
  - Redeem: `target` `"next"` → no `creditId`; otherwise `creditId = target` and the target must be an id seen in the last listing for that account (else 400 `invalid_request`). `idempotencyKey` = `randomUUID()` per POST. Outcome mapping: `reset` → `reset`, `nothingToReset` → `nothing_to_reset`, `noCredit` → `no_credit`, `alreadyRedeemed` → `already_redeemed`; JSON-RPC error → `failed` with a fixed message (the error text goes to the daemon log, not the body).
- Agents → sources: `omp` → omp source; `codex` → Codex source; anything else → `resets_unsupported`.
- PWA (`usage/UsageView.tsx` and a new `usage/ResetsSection.tsx`): when the session's agent is `omp` or `codex`, the usage drawer loads `GET .../usage/resets` after the usage and shows a "Resets salvos" section under the limit cards: one row per entry with the account label, a provider chip, "<A> salvos · <U> disponíveis agora", "expira <when>" when known, and the note in muted text. Each row has a "Usar reset" button, enabled only when `usable > 0`. It opens a confirmation (ActionSheet or dialog): title "Usar 1 reset?", body "<accountLabel> · <providerLabel>. Gasta um reset salvo e libera o limite agora. Não dá para desfazer.", actions "Usar reset" and "Cancelar". Only the confirm button sends the POST. While it runs, the button shows a spinner and every reset button is disabled. The reply `message` appears inline (success styling for `reset`, neutral otherwise), then the drawer refetches usage and resets. `message` from the list (no entries) shows as muted text. Errors use the existing ErrorNotice. lucide icons only, no emoji.
- Tests (fake agent and a fake app-server fixture only; NEVER the real omp or codex for a redeem, and never `account/rateLimitResetCredit/consume` against the real backend):
  - shared: the four schemas, error codes.
  - daemon: the omp list parser (saved/usable, expires, reason, active, unavailable, no accounts, load failure, unrelated lines ignored); target validation (bad provider, bad id, extra text); outcome mapping; the fake ACP agent answers `/usage reset` and `/usage reset anthropic/1` and the routes return parsed entries and outcomes; 400 for claude/agy/shell; concurrent redeem → 409; caches dropped after a redeem; Codex with a fake app-server (a node fixture speaking the line protocol, selected through `CODEX_PATH`): list mapping (credits null, credits with ids, expiry ISO), consume with a unique `idempotencyKey` per call, unknown credit id → 400, outcome mapping, JSON-RPC error → `failed`, timeout kills the fixture.
  - PWA: api client (list, redeem, error codes); a pure helper for the row text and button state.

## Extra (05/11) — several accounts per agent

Request (05/11): "I have Claude Code with 3 accounts; I want to switch between them, with the same settings on every account. Same for Codex. Ready for future providers."

Verified on this PC (05/11, no login completed, no credential copied):
- Claude Code 2.1.318 reads its whole state from `CLAUDE_CONFIG_DIR` when set: `.credentials.json`, `settings.json`, `projects/` and also `.claude.json` (created inside that folder, not in `%USERPROFILE%`). `claude auth status` with an empty folder → `"loggedIn": false`.
- Codex 0.165 reads `CODEX_HOME`. An empty `CODEX_HOME` with only a copy of `sessions/` listed the existing threads through the app-server (`thread/list` rebuilt its state DB from the rollout files); `account/read` → `account: null`.
- `claude auth login` in a PTY (cols 400) with `CLAUDE_CONFIG_DIR` set prints `If the browser didn't open, visit: <url>` (the URL is inside an OSC 8 hyperlink `ESC ] 8 ; id=... ; <url> ESC \ <url> ESC ] 8 ; ; ESC \`; its redirect is `https://platform.claude.com/oauth/code/callback`, which shows a code), then `Paste code here if prompted > `. It also tries to open a browser tab on the PC.
- `codex login --device-auth` with `CODEX_HOME` set prints `https://auth.openai.com/codex/device` and a one-time code like `0HKH-0YU99` ("expires in 15 minutes"). Cursor-movement escapes sit between the lines: replacing CSI sequences with nothing glues `device` to the next line, so the stripper replaces non-SGR CSI sequences with a space.

### Model
- The **principal** account of an agent is its normal home (`%USERPROFILE%\.claude` + `%USERPROFILE%\.claude.json`, `%USERPROFILE%\.codex`). Id `default`, label "Principal". Nanachi never creates, moves or deletes it.
- Every other account is a **profile home** `<NANACHI_HOME>\accounts\<agent>\<accountId>\` (accountId = `randomUUID()`). Processes for that account get `<homeEnv>=<profile home>`.
- A profile shares configuration and history with the principal, and keeps credentials and account state private. `prepareProfile(adapter, principalHome, profileHome)` runs before every spawn for that account (session agent, usage probe, login, Codex app-server):
  - **Shared directories**: a directory junction (`fs.symlink(target, path, 'junction')`, no admin needed) in the profile pointing to the same name in the principal home. Missing in the principal → create it there (empty) first. Already a junction to the right target → nothing. A real directory (or a junction elsewhere) at that path → leave it, log a warning, never delete it.
  - **Shared files**: copied from the principal on every prepare (overwrite). Missing in the principal → leave the profile's copy alone.
  - **Private**: everything else. Created by the agent itself in the profile.
  - Adapter step for Claude: merge `.claude.json`. Read the principal `.claude.json` and the profile's (missing → `{}`). Set only the shared keys from the principal: `mcpServers`, `projects`, `hasCompletedOnboarding`, `lastOnboardingVersion`, `theme`. Keep every other key of the profile (`oauthAccount`, `userID`, caches...). Write atomically (temp file + rename). Principal invalid JSON or missing → skip the merge with a warning.
- Adapters (`packages/daemon/src/accounts/adapters.ts`, one registry keyed by agent id; adding a harness = one entry plus tests):
  - `claude`: `homeEnv: "CLAUDE_CONFIG_DIR"`. Principal home: `CLAUDE_CONFIG_DIR` from the agent env (`agents.claude.env`, then the daemon env) or `%USERPROFILE%\.claude`; principal `.claude.json`: `<CLAUDE_CONFIG_DIR>\.claude.json` when that variable is set, else `%USERPROFILE%\.claude.json`. Shared dirs: `projects`, `skills`, `agents`, `commands`, `hooks`, `plugins`, `plans`, `file-history`, `todos`, `tasks`, `output-styles`. Shared files: `settings.json`, `keybindings.json` and every top-level `*.md` of the principal home (`CLAUDE.md` and its `@` imports). Login: `claude auth login` (executable `claude` resolved on the agent PATH, no shell), `needsCode: true`. Identity: the existing Claude verifier (`claude auth status`) run with `CLAUDE_CONFIG_DIR=<home>` (principal: unchanged behaviour).
  - `codex`: `homeEnv: "CODEX_HOME"`. Principal home: `CODEX_HOME` from the agent env or the daemon env, else `%USERPROFILE%\.codex`. Shared dirs: `sessions`, `archived_sessions`, `skills`, `prompts`, `rules`, `memories`, `.sandbox`, `.sandbox-bin`, `.sandbox-secrets`. Shared files: `config.toml`, `AGENTS.md`, `AGENTS.override.md`, `hooks.json`, `cap_sid`. Login: the bundled codex (same resolution as the Codex app-server client: `process.execPath <codex.js> login --device-auth`, or `CODEX_PATH login --device-auth`), `needsCode: false`, code pattern `\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b`. Identity: the existing `readCodexIdentity(<home>)` (payload of the `id_token` in `auth.json`, nothing else).
  - `omp`, `agy`, `shell` and any custom id: no adapter → accounts unsupported. omp keeps several accounts by itself (`/login`, per-session pin); Antigravity keeps its login in the Windows Credential Manager, so a second home cannot hold a second login.
- Deleting a profile home (`removeProfileHome`): resolve the path and refuse anything that is not strictly inside `<NANACHI_HOME>\accounts\<agent>\`. Then, for each top-level entry: `lstat`; a junction or symlink is removed as a link only (never followed); the rest is removed recursively. A unit test proves that a file inside a shared directory of the principal survives.

### Persistence (next migration)
```sql
CREATE TABLE agent_accounts (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_active_account (
  agent TEXT PRIMARY KEY,
  account_id TEXT NOT NULL
);
ALTER TABLE sessions ADD COLUMN account_id TEXT NULL;
```
`sessions.account_id` NULL = principal. No row in `agent_active_account` = principal. Additive only: the live daemon runs it on reload.

### shared
- `SessionSchema` gains `accountId: z.string().min(1).nullable().default(null)` (null = principal; the default keeps replies from older daemons valid).
- `AgentProfileSchema = { id: string ("default" = principal), label: string, isDefault: boolean, active: boolean, status, account, detail, checkedAt }` (the last four with the same meaning and rules as `AgentAccount`).
- `AgentAccountSchema` gains `supportsAccounts: z.boolean().default(false)` and `profiles: z.array(AgentProfileSchema).default([])`. Its existing top-level fields keep describing the principal.
- `AccountLoginStateSchema = { accountId, state: "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled", url: string | null, userCode: string | null, needsCode: boolean, codeSent: boolean, output: string, error: string | null, account: string | null }`. `output` = the last 4000 characters of the login output with escapes stripped.
- Request schemas: `CreateAgentAccountRequestSchema = { label: string trimmed 1..40 }`, `RenameAgentAccountRequestSchema` (same), `SetActiveAccountRequestSchema = { accountId: string }`, `AccountLoginCodeRequestSchema = { code: string 1..2000 without control characters }`, `SetSessionAccountRequestSchema = { accountId: string }`. `CreateSessionRequest` gains `accountId?: string`.
- Session event `account_changed { accountId: string | null, label: string }`, persisted like the other events.
- New error codes: `accounts_unsupported` (400), `account_in_use` (409), `too_many_accounts` (409), `login_in_progress` (409), `invalid_state` (409).

### Routes (Bearer)
`:agent` must be a configured agent: unknown → 404 `not_found`; no adapter → 400 `accounts_unsupported`. `:accountId` unknown for that agent → 404 `not_found`.
- `GET /api/agents/accounts[?refresh=1]`: as today, each entry now carries `supportsAccounts` and `profiles` (principal first, then by `created_at`; `active` marks the account new sessions use). Identity checks per profile share the existing 5 min cache (keyed by agent and account), the 15 s timeout and the "never return secrets" rules.
- `POST /api/agents/:agent/accounts { label }` → 201 `AgentProfile` (status `logged_out`). Inserts the row and runs `prepareProfile`. More than 10 accounts for one agent → 409 `too_many_accounts`.
- `PATCH /api/agents/:agent/accounts/:accountId { label }` → 200 `AgentProfile`. `default` → 400 `invalid_request`.
- `DELETE /api/agents/:agent/accounts/:accountId` → 204. `default` → 400 `invalid_request`. A session with a live process on that account → 409 `account_in_use`. Cancels its login, removes the profile home, the row and an active pointer to it (back to principal), and sets `account_id = NULL` on its sessions.
- `PUT /api/agents/:agent/accounts/active { accountId }` → 200 `{ accountId }` (`default` allowed).
- Login (`packages/daemon/src/accounts/login.ts`):
  - `POST /api/agents/:agent/accounts/:accountId/login` → 200 `AccountLoginState`. Starts a PTY with the adapter's login command (cols 500, rows 50, so the URL never wraps), cwd = the account home, env = the daemon env without any `NANACHI_*` variable, with the agent PATH, plus `<homeEnv>=<profile home>` (principal: no override, so it logs in the principal again). One login per agent at a time: a different account already logging in → 409 `login_in_progress`; the same account → returns the running state.
  - Output parsing: drop OSC sequences (`ESC ]` up to `BEL` or `ESC \`), drop SGR (`ESC [ ... m`), replace every other CSI sequence with a space, normalise `\r\n`. `url` = first `https://[^\s"'<>]+`; `userCode` = the adapter's code pattern, searched only after the URL. URL found → state `waiting`.
  - `GET .../login` → the state (404 `not_found` when none). Finished states stay in memory for 10 minutes.
  - `POST .../login/code { code }` → 200 state. Only when `needsCode` and `waiting`, else 409 `invalid_state`. Writes `code + "\r"` to the PTY and sets `codeSent`. The code is never logged, persisted or echoed back in `output` (replace it with `••••` if the PTY echoes it).
  - `DELETE .../login` → 204, kills the PTY tree, state `cancelled`.
  - Exit 0 → `verifying` → identity check on the account home → `succeeded` with `account` = e-mail, or `failed` with "o login terminou, mas a conta não aparece conectada". Exit ≠ 0 → `failed` ("o login falhou (código N)"). No exit after 15 minutes → kill, `failed` ("tempo esgotado"). Login output is never written to the daemon log. Success drops the identity cache of that account.
- Session account:
  - `POST /api/sessions` (ACP agent with an adapter): `accountId` optional, defaults to the agent's active account; unknown → 400 `invalid_request`. Agent without an adapter + `accountId` other than `default` → 400 `accounts_unsupported`. Stored as `account_id` (NULL for principal). "Retomar do PC" uses the active account.
  - `PUT /api/sessions/:id/account { accountId }` → 200 `Session`. Same account → 200, no change. Status `starting`, `running` or `awaiting_permission` → 409 `session_busy`. Otherwise: save `account_id`, append the `account_changed` event, and if the session has a live agent process, stop that process without a push and resume the session through the existing Retomar path (`session/load`/`session/resume`) under the new account. A `stopped`/`error` session just stores it: the next prompt resumes with the new account.
  - `agentLaunch` adds `<homeEnv>=<profile home>` (after `prepareProfile`) for sessions whose account is not the principal. Reload-resume keeps each session's account (it reads `account_id`).
  - Usage probe: one slot per `<agent>:<accountId>`; cwd `<NANACHI_HOME>\usage-probe\<agent>` for the principal (unchanged) and `<NANACHI_HOME>\usage-probe\<agent>@<accountId>` for other accounts, with the session file next to it; the probe env gets the account home. The resets routes (previous section) use the session's account the same way, and the Codex app-server client gets `CODEX_HOME` for it.

### PWA
- Settings → "Contas dos agentes": for an agent with `supportsAccounts`, its profiles as rows (principal first): status dot, label, e-mail or detail, and a "Em uso" badge on the active one. Tap → ActionSheet: "Usar em novas sessões" (PUT active), "Entrar" (login sheet), "Renomear" (NameSheet), "Remover" (confirmation; not for the principal). A last row "Adicionar conta" → NameSheet (label) → create → opens the login sheet.
- Login sheet (`AccountLoginSheet`): polls `GET .../login` every 1.5 s while open. Shows: "Abra o link e entre com a conta que você quer adicionar" with an "Abrir link" button (`target="_blank"`, `rel="noopener noreferrer"`) and a copy button; Codex: the `userCode` large and monospaced with a copy button; Claude (`needsCode`): "Depois de entrar, copie o código que aparece e cole aqui", a text field and "Enviar". States: "Preparando...", "Aguardando você entrar...", "Verificando...", success "Conta conectada: <email>" (closes and refreshes the list), failure with the error and a collapsible monospaced output. "Cancelar" sends DELETE. Mention under the link (Claude only): "O PC também pode abrir uma aba de login; pode ignorar."
- New-session sheet: a "Conta" select when the agent supports accounts and has more than one profile; default = the active one.
- Session configuration sheet: a "Conta" row (same condition). Changing it sends PUT; disabled while the session is starting, running or awaiting permission, with the hint "Troque quando o agente terminar".
- Usage drawer header: "Conta: <label>" (and the e-mail when known) for agents with accounts.
- Chat: `account_changed` renders as a small centered muted line "Conta trocada para <label>".
- lucide icons only, no emoji.

### Tests
- daemon unit, temp dirs only: adapter homes with and without env overrides; `prepareProfile` (junctions created and reused, missing principal dir created, files copied and overwritten, private files untouched, a real dir at a shared path left alone, `.claude.json` merge keeps the profile's `oauthAccount`/`userID` and takes the shared keys, invalid principal JSON); `removeProfileHome` (principal data in a shared dir survives; a path outside the accounts root is refused); login flow with fixture commands (a node script that prints an OSC-8 URL and `Paste code here if prompted > `, reads a line, writes a fake credential file and exits 0; one that prints a device URL and code, then exits 0; one that exits 1; one that never exits, for the timeout and DELETE); code echo masked; routes (CRUD, active, limits, 409s, unsupported agent, unknown account); session create with `accountId` and the env the fake agent receives (configure an agent with id `claude` that runs the fake agent; the fake agent reports an env variable on request); PUT account on an idle session stops it, appends `account_changed` and resumes it with the new env; busy → 409; usage probe slots per account; migration on a database at the previous version.
- Allowed checks on the real harnesses (no LLM call, nothing spent, nothing logged in): `claude auth status` with an empty profile home → logged out; the Codex app-server `account/read` on an empty profile → null. NEVER complete a real login, never read or copy `.credentials.json` or `auth.json` contents.
- PWA: api client tests for every new route, schema parsing with and without the new fields, a pure helper mapping the login state to the sheet's step.

### Limits (documented, not fixed)
- Settings changed while using a secondary account (Claude `/config` writing `settings.json`, Codex trusting a project in `config.toml`) are overwritten from the principal on the next spawn. Edit settings on the principal.
- Claude `.claude.json` keys other than the shared ones are per account (tips, caches). Codex thread names (`session_index.jsonl`) and its SQLite state are per account; threads still list from the shared rollouts.
- `claude auth login` opens a browser tab on the PC as well.
- Codex with `[windows] sandbox = "elevated"` on a profile home was not checked with a real turn.

## Fases seguintes (detalhadas quando a anterior fechar)
2. Claude Code (`claude-agent-acp`), várias sessões por workspace, histórico SQLite, retomar sessões, ressincronização.
3. `phone-send` (+ `--screenshot`), anexos do celular, Web Push (VAPID).
4. Codex (`codex-acp`) e Antigravity (adaptador sobre `agy` stream-json) + modo PTY (`node-pty`) de reserva.
5. Vários PCs (CORS, VAPID compartilhado), worktrees, diffs, revogar dispositivos pelo app, início automático (Agendador de Tarefas).
