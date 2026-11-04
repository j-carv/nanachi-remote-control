<div align="center">
  <img src="packages/pwa/public/icon-512.png" alt="Logo do Nanachi Remote" width="160" />

  <h1>Nanachi Remote</h1>

  <p><strong>Seus agentes no PC. Você no celular.</strong></p>
  <p>Converse com seus agentes de código, acompanhe o trabalho e aprove ações sem ficar preso à mesa.</p>

  <p>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22 ou superior" /></a>
    <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/PC-Windows-0078D4?style=flat-square" alt="Daemon para Windows" /></a>
    <a href="#instalar-no-celular"><img src="https://img.shields.io/badge/PWA-Android%20%2B%20iPhone-8B5CF6?style=flat-square&logo=pwa&logoColor=white" alt="Web app para Android e iPhone" /></a>
    <a href="https://www.tailscale.com/"><img src="https://img.shields.io/badge/Rede-Tailscale-242424?style=flat-square&logo=tailscale&logoColor=white" alt="Conexão via Tailscale" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.9" /></a>
  </p>

  <p><a href="#começar-no-pc">Instalação</a> · <a href="#instalar-no-celular">Android e iPhone</a> · <a href="#no-dia-a-dia">Como usar</a> · <a href="#quando-algo-não-funcionar">Ajuda</a></p>
</div>

---

## A ideia

Você deixa um agente trabalhando no Windows e continua a conversa pelo celular. O Nanachi é a ponte: organiza projetos e sessões, mostra o chat e o terminal, recebe anexos e avisa quando precisa de você.

O painel é servido pelo seu próprio PC, dentro da sua rede Tailscale. **Não precisa hospedar um backend na nuvem, abrir portas no roteador ou usar WSL.** Os agentes continuam usando os serviços e as contas de IA deles — o Nanachi não substitui essas contas nem torna os modelos locais.

> O PC precisa estar ligado, conectado ao Tailscale e com o daemon rodando. O celular é o controle remoto, não o lugar onde o agente executa.

### O que dá para fazer

- **Conversar com os agentes** com respostas em tempo real, Markdown, código e detalhes das ferramentas.
- **Escolher modelo, acesso e esforço** quando o agente oferece essas opções, e responder pedidos de permissão pelo chat.
- **Usar comandos `/`** anunciados pelo agente, com busca no próprio campo de mensagem.
- **Retomar sessões do PC** quando o agente suporta listar e reabrir o histórico.
- **Mandar fotos e arquivos** e receber arquivos ou capturas de tela do PC no chat.
- **Ver alterações Git** e abrir sessões em worktrees separados para não mexer no checkout principal.
- **Alternar entre PCs**, silenciar projetos e revogar aparelhos pareados.
- **Receber notificações**, inclusive com o app fora de foco, se o sistema e o navegador permitirem.

### Agentes

| Agente | Como aparece no app | O que preparar no PC |
| --- | --- | --- |
| Oh My Pi (`omp`) | Chat via ACP | Instalar o `omp`, deixar no PATH e configurar a conta. |
| Claude Code | Chat via ACP | Fazer o login local; o adaptador `claude-agent-acp` vem com o daemon. |
| Codex | Chat via ACP | Fazer o login local; o adaptador `codex-acp` vem com o daemon. |
| Antigravity (`agy`) | Terminal interativo | Instalar o `agy`, fazer login e aceitar a confiança nas pastas que vai usar. |

ACP é o protocolo de conversa com os agentes. O Antigravity usa um terminal de verdade; por isso algumas funções de chat e retomada não se aplicam a ele.

## Antes de instalar

No **PC**:

- Windows — o ambiente de desenvolvimento do projeto é Windows 11.
- [Node.js](https://nodejs.org/) **22 ou superior**, com npm.
- [Git](https://git-scm.com/) no PATH, para clonar o projeto, ver alterações e usar worktrees.
- [Tailscale](https://tailscale.com/download) instalado e conectado.
- Pelo menos um dos agentes que você quer usar, com a conta configurada no terminal.

No **celular**:

- Tailscale instalado, com acesso à mesma tailnet do PC.
- **Android:** Chrome atualizado é o caminho recomendado para instalar o web app.
- **iPhone:** Safari. Para notificações, iOS **16.4 ou superior** e app instalado na Tela de Início.

No [painel do Tailscale](https://login.tailscale.com/admin/dns), habilite **HTTPS Certificates**, na área de DNS. É isso que permite abrir o painel com HTTPS e instalar o PWA corretamente.

## Começar no PC

Os comandos abaixo são executados na raiz do projeto, no PowerShell ou no terminal que você usa no Windows.

### 1. Baixar e compilar

```powershell
git clone https://github.com/j-carv/nanachi-remote-control.git
cd nanachi-remote-control
npm install
npm run build
```

### 2. Criar a configuração

```powershell
npm run start -w @nanachi/daemon
```

Na primeira execução, o daemon cria a pasta `%USERPROFILE%\.nanachi-remote` e o arquivo `config.json`. Pare com **Ctrl+C**, abra o arquivo e ajuste as pastas e o login autorizados:

```json
{
  "port": 7777,
  "host": "127.0.0.1",
  "machineName": "Meu PC",
  "allowedRoots": ["C:\\Projetos", "D:\\Dev"],
  "allowedTailscaleLogins": ["seu-login@exemplo.com"],
  "corsOrigins": []
}
```

Use pastas que existem na sua máquina. O login é o da sua conta Tailscale; confira com `tailscale status`. Preserve os demais campos que já estiverem no arquivo.

- `allowedRoots` define quais pastas aparecem para criar workspaces. **Não é uma sandbox para os agentes.**
- `allowedTailscaleLogins` define quem pode acessar pela tailnet. Não deixe vazio: vazio aceita qualquer login que chegue pelo Tailscale Serve.
- `host` fica em loopback. Não troque por `0.0.0.0` — o daemon não aceita escutar diretamente na rede.

Suba o daemon de novo e mantenha esse terminal aberto:

```powershell
npm run start -w @nanachi/daemon
```

### 3. Disponibilizar na sua tailnet

Em **outro terminal**:

```powershell
tailscale serve --bg http://localhost:7777
tailscale serve status
```

Anote o endereço HTTPS mostrado, algo como `https://meu-pc.minha-tailnet.ts.net`. É esse endereço que você vai abrir no celular. Se sua versão do Tailscale tiver opções diferentes, consulte a [referência do Serve](https://tailscale.com/kb/1242/tailscale-serve).

> **Use `tailscale serve`, nunca `tailscale funnel`.** Serve mantém o acesso na sua tailnet; Funnel publica o serviço na internet. Não encaminhe a porta 7777 no roteador.

### 4. Gerar o código de pareamento

Com o daemon rodando:

```powershell
npm run pair -w @nanachi/daemon
```

Ele mostra um código de **6 dígitos**, válido por **5 minutos** e de uso único. Agora vá para o celular.

## Instalar no celular

### Android

1. Abra o **Tailscale** no Android, entre na sua conta e confira se está conectado à mesma tailnet do PC.
2. No **Chrome**, abra o endereço HTTPS do PC mostrado pelo `tailscale serve status`.
3. Toque no menu **⋮** do Chrome → **Instalar e criar atalho → Instalar**. Dependendo da versão, o caminho aparece como **Adicionar à tela inicial → Instalar** ou diretamente **Instalar app**.
4. Confirme e abra o **Nanachi Remote pelo ícone** criado no launcher ou na tela inicial. Ele deve abrir em uma janela própria, sem a barra de endereço.
5. Toque em **Parear máquina**, confira o endereço do PC, informe o código de 6 dígitos e dê um nome ao aparelho.
6. Em **Ajustes** do Nanachi, ative as notificações e aceite a permissão do Chrome/Android, se solicitada.

Não é um APK e não precisa da Play Store. A instalação é feita pelo próprio navegador; veja também o [guia de apps da Web do Chrome para Android](https://support.google.com/chrome/answer/9658361?hl=pt-BR&co=GENIE.Platform%3DAndroid).

**Só apareceu “Criar atalho”?** Confira se está usando o Chrome atualizado, no endereço **HTTPS**, e não em uma aba anônima ou no navegador interno de outro app. Abra a página diretamente no Chrome. Os nomes dos menus podem variar conforme a versão e o fabricante.

Para receber avisos, mantenha o Tailscale conectado. Se eles não chegarem, confira as permissões de notificações do app/Chrome nas configurações do Android. Restrições de bateria do fabricante também podem atrasar a conexão ou as notificações.

### iPhone

1. Abra o **Tailscale**, conecte-se à mesma tailnet e deixe-o ativo.
2. No **Safari**, abra o endereço HTTPS do PC.
3. Toque em **Compartilhar → Adicionar à Tela de Início** e confirme.
4. Abra o Nanachi **pelo ícone da Tela de Início**, não pela aba do Safari.
5. Toque em **Parear máquina**, confira o endereço, informe o código e dê um nome ao aparelho.
6. Em **Ajustes**, ative as notificações e aceite a permissão do iOS.

No iPhone, notificações web exigem **iOS 16.4+** e o app instalado na Tela de Início. Deixar só a página aberta no Safari não basta.

**O código expirou?** Gere outro no PC com o mesmo comando. Cada aparelho precisa do próprio pareamento.

## No dia a dia

### Abrir um projeto e conversar

1. Selecione o PC na tela de máquinas.
2. Toque em **+ Workspace**, navegue até uma das pastas autorizadas e escolha **Usar esta pasta**.
3. Dentro do workspace, toque em **Nova sessão**, escolha o agente e ajuste as opções que ele disponibilizar.
4. Toque em **Criar sessão** e mande sua mensagem.

Os seletores de modelo, acesso e esforço dependem do agente, e o app lembra a última escolha de cada um. Pedidos de permissão aparecem como cartões no chat. **Parar** interrompe o trabalho atual.

Digite `/` no começo da mensagem ou use o botão de comandos para ver o que o agente anunciou. Se ele não anunciar comandos, não há uma lista universal para mostrar.

### Continuar de onde parou

- **Retomar:** reabre uma sessão parada ou com erro, quando o agente suporta retomada.
- **Retomar do PC:** lista sessões do agente para aquele workspace e permite trazê-las para o app, quando a listagem é suportada.
- **Encerrar:** para o processo, mas mantém a sessão na lista.
- **Remover do app:** apaga o registro, os eventos e os arquivos daquela sessão no Nanachi. Se estiver trabalhando, ela será interrompida. Isso **não apaga o histórico próprio do agente**.

Sessões de terminal do Antigravity não são retomadas. Se o agente não oferecer retomada, crie uma sessão nova.

### Fotos, arquivos e prints

Use o clipe no chat para anexar fotos ou arquivos. Imagens são enviadas como imagem quando o agente aceita esse tipo de entrada; caso contrário, ele recebe o caminho do arquivo.

No sentido PC → celular, um agente executado dentro de uma sessão Nanachi pode usar:

```powershell
phone-send "C:\Projetos\meu-app\resultado.png" --caption "Olha como ficou"
phone-send --screenshot
```

O arquivo aparece no chat e pode gerar uma notificação. O comando só funciona **dentro da sessão do Nanachi**; não é um utilitário global para qualquer terminal.

Por padrão, o app avisa sobre o `phone-send` no primeiro prompt de uma sessão ACP nova. Sessões importadas ou retomadas não recebem esse aviso; nesses casos, explique o comando ao agente ou inclua-o nas instruções globais dele. `phoneSendHint: false` no `config.json` desativa o aviso automático.

### Git e terminal

Em um workspace Git, **Alterações** mostra arquivos modificados, inclusive os não rastreados, e o patch de cada um. Para isolar uma tarefa, marque **Em worktree separado** ao criar a sessão: ela ganha checkout e branch próprios.

Ao encerrar, o app pode remover o worktree. Se houver alterações sem commit, a remoção é recusada para preservar o trabalho; o branch só é apagado se já estiver mergeado.

Sessões do Antigravity abrem um terminal com teclas como Esc, Tab, Ctrl+C, setas e Enter. Faça o primeiro login e aceite a confiança na pasta pelo terminal do PC antes de usá-lo pelo celular.

## Deixar pronto para quando precisar

Depois do primeiro build, você pode instalar o início automático e ligar o supervisor agora:

```powershell
npm run autostart -w @nanachi/daemon -- install
npm run autostart -w @nanachi/daemon -- start
```

Isso cria um atalho na pasta **Inicializar** do Windows, sem precisar de administrador. Ele inicia o supervisor sem janela **ao fazer logon**, na sua sessão de usuário — não é um serviço do Windows.

O supervisor acompanha alterações no código, recompila e mantém o daemon rodando. Isso é **recarga do código local**, não atualização automática por `git pull`.

<details>
<summary><strong>Como funciona a recarga e onde ficam os logs</strong></summary>

- Mudanças no daemon ou em `shared` aguardam **60 segundos sem novos builds** e nenhuma sessão trabalhando ou esperando permissão antes do reload. O intervalo é configurável em `reloadQuietMs`.
- Sessões ACP ociosas são salvas e retomadas após o reload; terminais ficam parados. Falhas de retomada são registradas no log.
- Mudanças no PWA não reiniciam o daemon. O service worker atualiza o app; reabra-o para receber a versão nova.
- Se o daemon cair, o supervisor tenta reiniciar com espera crescente, até 30 segundos.
- Só uma instância do supervisor roda por vez.
- Logs: `%USERPROFILE%\.nanachi-remote\supervisor.log`, com rotação ao passar de 5 MB. Erros de início ficam em `supervisor-start.log`.

Para acompanhar no terminal, use `npm run supervise`. Ctrl+C encerra o supervisor e seus filhos. Não rode um daemon manual na mesma porta ao mesmo tempo.

</details>

## Mais de um PC

Cada PC tem seu daemon e seus dados. Você instala o web app uma vez e adiciona as outras máquinas nele.

1. Repita a instalação no segundo PC, incluindo configuração e Tailscale Serve.
2. No `config.json` **do segundo PC**, autorize a origem HTTPS de onde você instalou o app:

   ```json
   "corsOrigins": ["https://pc-principal.minha-tailnet.ts.net"]
   ```

3. Reinicie o segundo daemon, gere um código nele e, no celular, toque em **Parear máquina**. Use o endereço HTTPS do segundo PC e o código dele.
4. Para notificações de todos os PCs, copie o arquivo `vapid.json` da pasta `.nanachi-remote` do principal para a mesma pasta de dados nos outros PCs, **antes de iniciar os daemons de destino e ativar os avisos**. Se já estiverem rodando, pare-os antes e reinicie depois. Todas as máquinas precisam da mesma chave. Reative as notificações no app se já estavam configuradas.

**O `vapid.json` contém uma chave privada.** Transfira só entre seus PCs, por um meio seguro, e nunca faça commit dele.

## Segurança, sem letras miúdas

O Nanachi permite controlar processos que rodam com **o seu usuário do Windows**. Trate um celular pareado como uma chave de acesso ao seu PC.

- O daemon só escuta em loopback; o acesso remoto deve passar pelo **Tailscale Serve**.
- Use `allowedTailscaleLogins` e as regras de acesso da sua tailnet para limitar quem chega ao serviço.
- Cada aparelho recebe seu token. O banco guarda o hash, não o token original. O código de pareamento expira em 5 minutos e tem limite de tentativas.
- **`allowedRoots` não isola o agente.** Ele pode acessar outras pastas com as permissões do seu usuário. Use os modos de aprovação do agente, principalmente com projetos de terceiros.
- Perdeu o celular? Revogue em **Ajustes → Dispositivos desta máquina**, ou pelo CLI abaixo. A revogação encerra a conexão.
- Não publique `config.json` com dados pessoais, `data.db`, `vapid.json`, tokens, anexos ou logs da sua pasta de dados.
- Não use Funnel nem exponha a porta do daemon na internet.

<details>
<summary><strong>Detalhes de proteção e limites</strong></summary>

O daemon valida Host e Origin, limita origens extras por `corsOrigins` e verifica o login repassado pelo Tailscale. As rotas `/api/agent/*`, usadas pelo `phone-send`, recusam chamadas encaminhadas pelo proxy. O token do agente é por sessão, só existe em memória e deixa de valer ao encerrar o daemon.

Cada sessão admite até **200 arquivos e 500 MiB**, somando os dois sentidos. Notificações de arquivo têm intervalo mínimo de 60 segundos por sessão. PNG, JPEG, GIF e WebP podem aparecer inline; outros downloads são enviados como `application/octet-stream`.

O serviço de push só aceita endpoints HTTPS dos provedores previstos no daemon (FCM, Mozilla, WNS e Apple). Inscrições expiradas, com resposta 404 ou 410, são removidas.

</details>

## Comandos úteis

Execute na raiz do repositório. Os comandos de início usam o resultado de `npm run build`.

| Comando | Para quê |
| --- | --- |
| `npm run start -w @nanachi/daemon` | Rodar o daemon no terminal. |
| `npm run pair -w @nanachi/daemon` | Gerar um código para um aparelho novo. |
| `npm run devices -w @nanachi/daemon` | Listar aparelhos e seus IDs. |
| `npm run revoke -w @nanachi/daemon -- <id>` | Revogar um aparelho. Substitua `<id>` pelo ID listado. |
| `npm run autostart -w @nanachi/daemon -- status` | Ver o estado do início automático e do supervisor. |
| `npm run autostart -w @nanachi/daemon -- stop` | Parar supervisor e processos filhos. |
| `npm run autostart -w @nanachi/daemon -- uninstall` | Remover o atalho de logon; não para processos já abertos. |
| `npm run vapid -w @nanachi/daemon -- show` | Ver o caminho da chave de push e sua parte pública. |
| `npm run supervise` | Compilar e acompanhar os builds e o daemon no terminal. |

<details>
<summary><strong>Referência do config.json</strong></summary>

A pasta de dados padrão é `%USERPROFILE%\.nanachi-remote`. Para usar outra, defina `NANACHI_HOME` no ambiente de **todos** os comandos do daemon e do CLI.

| Campo | Padrão | Função |
| --- | --- | --- |
| `port` | `7777` | Porta local; ajuste também o destino do Tailscale Serve se mudar. |
| `host` | `127.0.0.1` | Só aceita `127.0.0.1`, `::1` ou `localhost`. |
| `machineName` | Nome do PC | Nome exibido no app. |
| `allowedRoots` | `[]` | Raízes disponíveis para escolher workspaces. |
| `allowedTailscaleLogins` | `[]` | Logins autorizados; vazio aceita qualquer login encaminhado pelo Serve. |
| `corsOrigins` | `[]` | Origens extras, como a do PC principal em uma instalação com várias máquinas. |
| `phoneSendHint` | `true` | Avisa o agente sobre `phone-send` no primeiro prompt de uma sessão ACP nova. |
| `reloadQuietMs` | `60000` | Espera sem novos builds antes do reload pelo supervisor. |
| `agents` | omp, claude, codex, agy | Mapa de agentes, com `label`, `command`, `args`, `env` e `kind` (`acp` ou `pty`). |

Uma entrada em `agents` substitui o padrão do mesmo ID. Agentes padrão não definidos no arquivo continuam disponíveis em memória. Depois de editar a configuração, reinicie o daemon.

</details>

## Quando algo não funcionar

| Sintoma | O que conferir |
| --- | --- |
| O endereço não abre no celular | PC ligado, daemon rodando, Tailscale conectado nos dois aparelhos e endereço HTTPS correto em `tailscale serve status`. |
| Não aparece pasta para criar workspace | `allowedRoots` precisa ter pelo menos uma pasta existente. Reinicie o daemon depois de editar. |
| Código inválido ou expirado | Gere outro com `npm run pair -w @nanachi/daemon`; ele só vale uma vez, por 5 minutos. |
| Android só cria um atalho | Use Chrome atualizado, HTTPS e uma aba normal. Procure **Instalar app** ou **Adicionar à tela inicial → Instalar**. |
| Notificações não chegam | Confira permissões do sistema/navegador, Tailscale ativo e, em vários PCs, a mesma chave VAPID. No iPhone, use iOS 16.4+ e abra pelo ícone instalado. |
| Notificações pararam depois de funcionar | Ative-as de novo em Ajustes; a inscrição pode ter expirado. No Android, confira também as restrições de bateria. |
| WebSocket não conecta | Confira se o proxy repassa os headers de origem. Se necessário, inclua a origem HTTPS do app em `corsOrigins` e reinicie. |
| O agente não inicia | Teste o comando no terminal, confirme PATH e login. `omp` e `agy` são instalados à parte. |
| Antigravity pede login ou confiança | Abra `agy` no PC uma vez e resolva as perguntas na pasta desejada. |
| Captura de tela fica preta | Rode o daemon na sessão de desktop do usuário. Um serviço do Windows não enxerga a mesma área de trabalho. |
| Porta 7777 ocupada | Não misture daemon manual e supervisor na mesma porta. Se trocar `port`, atualize também o Tailscale Serve. |
| Erro ao ler `config.json` | Confira JSON válido e o campo citado na mensagem. BOM UTF-8 do PowerShell 5.1 é aceito. |

## Para mexer no código

Monorepo com npm workspaces:

```text
packages/
  shared/   Tipos e schemas Zod do protocolo
  daemon/   API Fastify, WebSocket, SQLite, agentes e CLI
  pwa/      React, Vite, service worker e interface mobile
e2e/        Cenários ponta a ponta com Playwright e Edge
docs/       Contratos técnicos e notas do projeto
```

```powershell
npm install
npm run build
npm test
npm run typecheck
```

Para trabalhar com recarga integrada, use `npm run supervise`. Também existem `npm run dev -w @nanachi/daemon` e `npm run dev -w @nanachi/pwa` para trabalhar em cada pacote; compile `shared` antes. O Vite encaminha `/api` e `/ws` para `127.0.0.1:7777`. O fluxo de instalação e notificações deve ser conferido com o **PWA buildado e servido via HTTPS**, não só com o servidor de desenvolvimento.

<details>
<summary><strong>Testes ponta a ponta</strong></summary>

Depois de `npm run build`, os cenários abaixo sobem daemons temporários e usam agentes de teste, sem consumir uma conta de IA. Exigem Windows, Node 22+, Microsoft Edge e as portas usadas por cada cenário livres. As capturas geradas ficam em `e2e/screenshots/`, fora do versionamento.

| Comando | Cenário |
| --- | --- |
| `npm run e2e:34` | Anexos, arquivos enviados pelo PC, terminal e notificações. |
| `npm run e2e:5` | Vários PCs, worktrees, dispositivos e controle de origem. |
| `npm run e2e:resume` | Listagem, importação e remoção de sessões. |
| `npm run e2e:images` | Imagens no chat e visualizador. |
| `npm run e2e:commands` | Menu de comandos `/` e envio pelo chat. |
| `npm run e2e:chatperf` | Chat longo, rolagem e apresentação das mensagens. |

O `npm run e2e` básico é diferente: precisa de um daemon configurado na porta 7790, uma raiz autorizada e um código de pareamento. Ele usa o agente real. Exemplo: `npm run e2e -- --pair-code <código> --root-name <nome>`. Confira os requisitos no início de cada script antes de rodar. `E2E_BROWSER_CHANNEL=chrome` troca o navegador dos scripts que oferecem essa opção.

Os cenários com viewport de iPhone no navegador ajudam a conferir a interface, mas **não substituem validar instalação, teclado e push em um celular real**, Android ou iPhone.

</details>

Mais detalhes: [contratos e arquitetura](docs/PLAN.md) · [configuração manual](docs/PENDENTES-USUARIO.md).

---

Feito para acompanhar o trabalho de longe, sem entregar o controle do seu PC a um painel público. Comece com uma máquina, um projeto e um agente; adicione o resto quando precisar.
