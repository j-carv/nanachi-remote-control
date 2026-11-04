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
- `Session` ganha `configOptions: SessionConfigOption[]` (vazio até o agente responder). Persistido em `sessions.config_options TEXT` (JSON; migração 2 já cria a coluna).
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
- Medido no banco real (04/11, leitura somente): listagem de uma pasta com 2 sessões (omp + claude) caiu de 143.394 para 89.860 bytes. Sobra quase tudo em `configOptions` do omp (~86 KB por sessão), que vai na `Session`. Esse é o próximo alvo, fora deste contrato.
- Codex: o nome vem com `$` (`$brainstorming`). O ACP manda `/<nome>`, então o texto enviado é `/$brainstorming`. Não verificado com prompt real (a investigação não gasta prompts): se o codex-acp não reconhecer, o ajuste é só no `insertCommand`.
- `/loop` existe no claude e não no omp (apesar do pedido). Um `/loop` digitado num omp vai como texto e o agente decide o que fazer.
- Só o agente decide o efeito de um comando: o daemon não executa nada, só repassa o texto.

## Fases seguintes (detalhadas quando a anterior fechar)
2. Claude Code (`claude-agent-acp`), várias sessões por workspace, histórico SQLite, retomar sessões, ressincronização.
3. `phone-send` (+ `--screenshot`), anexos do celular, Web Push (VAPID).
4. Codex (`codex-acp`) e Antigravity (adaptador sobre `agy` stream-json) + modo PTY (`node-pty`) de reserva.
5. Vários PCs (CORS, VAPID compartilhado), worktrees, diffs, revogar dispositivos pelo app, início automático (Agendador de Tarefas).
