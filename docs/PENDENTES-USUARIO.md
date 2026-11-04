# Configuração manual

Checklist do que precisa ser feito na sua máquina e no celular. O passo a passo completo está no [README](../README.md).

## 1. Preparar o PC

- [ ] Instalar Node.js 22+, Git e Tailscale.
- [ ] Conectar o PC à sua tailnet.
- [ ] Na raiz do projeto, executar `npm install` e `npm run build`.
- [ ] Executar `npm run start -w @nanachi/daemon` uma vez para criar `%USERPROFILE%\.nanachi-remote\config.json` e parar com Ctrl+C.
- [ ] Editar `allowedRoots` com pastas existentes, por exemplo `["C:\\Projetos"]`.
- [ ] Preencher `allowedTailscaleLogins` com o login autorizado, conferido em `tailscale status`.
- [ ] Ativar **HTTPS Certificates** no painel DNS do Tailscale.
- [ ] Iniciar o daemon novamente e, em outro terminal, executar `tailscale serve --bg http://localhost:7777`.
- [ ] Conferir o endereço HTTPS com `tailscale serve status`. Não usar Funnel.
- [ ] Se quiser início automático ao fazer logon, executar `npm run autostart -w @nanachi/daemon -- install` e depois `npm run autostart -w @nanachi/daemon -- start`. Pare o daemon manual antes para não disputar a porta.

O supervisor recompila mudanças no código local e recarrega o daemon quando as sessões permitem. Ele não baixa atualizações do repositório.

## 2. Preparar os agentes

- [ ] Instalar e configurar pelo menos um agente. `omp` e `agy` precisam estar no PATH; os adaptadores ACP de Claude Code e Codex vêm nas dependências do daemon.
- [ ] Fazer os logins necessários no terminal do PC.
- [ ] Para Antigravity, abrir `agy` e aceitar a confiança nas pastas que serão usadas.

O Antigravity usa terminal interativo. Adaptadores ACP de terceiros não fazem parte da instalação padrão: revise o código e o acesso à sua conta antes de configurar um.

## 3. Instalar no celular

- [ ] Instalar o Tailscale e conectar à mesma tailnet do PC.
- [ ] **Android:** abrir o endereço HTTPS no Chrome e usar **⋮ → Instalar e criar atalho → Instalar**, **Instalar app** ou **Adicionar à tela inicial → Instalar**, conforme a versão.
- [ ] **iPhone:** abrir no Safari e usar **Compartilhar → Adicionar à Tela de Início**.
- [ ] Abrir o Nanachi pelo ícone instalado.
- [ ] No PC, gerar um código com `npm run pair -w @nanachi/daemon` e parear a máquina pelo app. O código vale 5 minutos e só pode ser usado uma vez.
- [ ] Ativar notificações nos Ajustes do Nanachi e aceitar a permissão do sistema. No iPhone, é necessário iOS 16.4+ e instalação na Tela de Início.
- [ ] Criar um workspace e uma sessão para conferir o agente escolhido.

## 4. Adicionar outros PCs

- [ ] Repetir a preparação em cada PC.
- [ ] No `config.json` dos PCs secundários, incluir a origem HTTPS do app em `corsOrigins`, por exemplo `["https://pc-principal.minha-tailnet.ts.net"]`.
- [ ] Com os daemons de destino parados, copiar o `vapid.json` do PC principal para a pasta de dados deles, por um meio seguro. Reiniciar depois. Fazer isso antes de ativar notificações para manter a mesma chave de push.
- [ ] Gerar o código de pareamento em cada PC e adicioná-lo pelo endereço HTTPS correspondente.

## 5. Permissões e dados

- [ ] Escolher modos de aprovação adequados em cada agente, especialmente ao abrir projetos de terceiros.
- [ ] Guardar `config.json`, `data.db`, `vapid.json`, anexos e logs fora do repositório.
- [ ] Saber como revogar um aparelho: Ajustes → Dispositivos desta máquina, ou `npm run devices -w @nanachi/daemon` seguido de `npm run revoke -w @nanachi/daemon -- <id>`.

`allowedRoots` limita a escolha de workspaces, mas não isola os agentes. Eles rodam com seu usuário do Windows e podem acessar outras pastas conforme suas permissões.

O aviso do `phone-send` já é enviado no primeiro prompt de sessões ACP novas, salvo se `phoneSendHint` estiver desativado. Para sessões importadas ou retomadas, você pode explicar o comando na conversa ou adicioná-lo às instruções globais do agente.
