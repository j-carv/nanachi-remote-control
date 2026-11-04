# Nanachi Remote: direção de design

Fonte da verdade visual do PWA (`packages/pwa`). Quem mexer em tela ou CSS segue este arquivo.

## Direção

- **Modo: Operate.** Ferramenta de trabalho de dev no iPhone. Escaneável, consistente, com cara de app nativo iOS. Nada de landing, gradiente ou animação de enfeite.
- **Densidade média-alta.** Listas compactas, leitura de código confortável (16px no markdown, 13px mono nos diffs), ações frequentes ao alcance do polegar (base da tela e barra do chat).
- **Um acento só: azul do sistema.** Sem roxo, sem brilho neon, sem gradiente.
- **Neutros de uma família só** (cinza azulado frio). Não misturar quente e frio.
- **Escuro e claro** pelo `prefers-color-scheme`. Os tokens mudam, os componentes não.

## Tokens (definidos em `:root` de `packages/pwa/src/styles.css`)

| Token | Escuro | Claro | Uso |
|---|---|---|---|
| `--bg` | `#0e1116` | `#f2f3f6` | fundo da tela |
| `--surface` | `#161a21` | `#ffffff` | grupo de lista, cartão |
| `--surface-2` | `#1e232c` | `#e8eaf0` | campo, botão secundário, código |
| `--surface-3` | `#272d38` | `#dcdfe7` | pressionado, hover |
| `--line` | `#2a303b` | `#d5d9e2` | separadores (1px) |
| `--text` | `#eef1f6` | `#111418` | texto principal |
| `--muted` | `#9aa3b2` | `#5a6170` | texto secundário (AA em todas as superfícies) |
| `--accent` | `#4d9dff` | `#2563eb` | link, foco, seleção (texto/borda) |
| `--accent-fill` | `#2563eb` | `#2563eb` | fundo de botão primário (texto branco, 5.2:1) |
| `--ok` / `--warn` / `--danger` | `#34d399` / `#f5b84a` / `#ff6b6b` | `#15803d` / `#a16207` / `#c81e1e` | status e erro |

Diff: `--add-bg`/`--add-ink`, `--del-bg`/`--del-ink` (verde e vermelho com fundo tingido; contraste AA).

Escala de raio: **10** (campos, botões, teclas), **14** (linhas de grupo, cartões, bolhas, composer), **20** (folha inferior), **999** (só pílulas de status e chips). Nada de raio misto dentro do mesmo componente.

Espaçamento em base 4: 4, 8, 12, 16, 20, 24, 32. Alvo de toque mínimo 44px.

Sombra: quase nenhuma. Separação por superfície e hairline. A única sombra é a do menu, tingida pelo fundo.

Tipografia (pilha do sistema: `-apple-system`, SF Pro; mono: `ui-monospace`, SF Mono):

- Título de tela 20/600, subtítulo 13 muted.
- Corpo 17 (lista), 16 (markdown, campos, sempre ≥16px para não dar zoom no iOS).
- Subtítulo de seção 13/600 muted, em caixa normal (sem caixa-alta).
- Mono 13 para caminho, diff, código, título de tool call. Números com `tabular-nums`.

Movimento: 200ms com `cubic-bezier(0.32, 0.72, 0, 1)` (folha, switch). Botão pressionado `scale(0.98)`. Sem loop infinito, exceto o spinner e a bolinha "conectando" (são estado). Tudo para sob `prefers-reduced-motion`.

Ícones: `@phosphor-icons/react`, peso regular, 20px, uma família só. Sem emoji na interface.

## Componentes

- **Cabeçalho (`ScreenHeader`)**: no topo da tela, rola com o conteúdo (não é fixo). Voltar à esquerda (44px, chevron), título e subtítulo, ações à direita. No chat e no terminal, a pílula de status fica nas ações, ao lado de "Alterações" (uma linha a mais no cabeçalho encolhe o terminal e quebra o replay do E2E).
- **Listas (`item-list` / `item-row`)**: grupo inset com fundo `--surface`, raio 14, separadores hairline. Não é um cartão por linha. Ação destrutiva é texto vermelho pequeno, nunca botão cheio.
- **Pílula de status**: texto + cor semântica, sem bolinha decorativa. Bolinha só na máquina (estado de conexão).
- **Botões**: primário (`--accent-fill`, texto branco), secundário (`--surface-2`), fantasma (texto acento ou muted), perigo (texto `--danger`). Um primário por tela.
- **Campos**: 16px, raio 10, borda `--line`, foco com anel de 2px `--accent`.
- **Seletores de opção do chat**: rótulo pequeno acima, campo compacto (36px). Select nativo (abre a roda no iOS).
- **Chat**: bolha do usuário com `--accent-fill` à direita; resposta do agente solta à esquerda em markdown; pensamento recolhido em texto muted; tool call é uma linha recolhível com status; diff em bloco mono; plano como checklist com ícones; cartão de permissão com borda de acento e botões de largura igual; composer fixo no rodapé (anexo, campo, Enviar).
- **Terminal**: área do xterm em fundo de código; barra de teclas em duas linhas (9 teclas, todas visíveis em 390px).
- **Folha (`sheet`)**: sobe de baixo, raio 20 no topo, puxador visual, ações no rodapé com safe-area.
- **Estados**: carregando como texto muted (sem spinner de tela cheia), vazio com frase curta e o que fazer, erro inline no bloco `error` (vermelho tingido) com a ação de reparear quando houver.

## Regras

- Tela de chat: a barra do composer e o botão Enviar ficam sempre acessíveis com o teclado aberto (`useVisualViewport`).
- Contraste AA em texto normal, 3:1 em ícone e borda de controle.
- Nada de `h-screen`: usa `100dvh`. Safe-area em todas as bordas (`env(safe-area-inset-*)`).
- Texto de interface em português, frase curta, sem exclamação e sem "Oops".
- Mudança de texto ou classe que os E2E usam (`e2e/run-phase34.mjs`, `e2e/run-phase5.mjs`) exige atualizar o script no mesmo commit.

## Ícone e tema do app

- Ícone: o dono do projeto coloca os próprios arquivos em `packages/pwa/public/` (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`). Não gerar nem trocar esses arquivos pelo código; os nomes e caminhos no manifest (`vite.config.ts`) ficam como estão. `scripts/generate-icons.mjs` é o gerador original (não usado para o ícone final).
- `theme-color`: `#0e1116` no escuro e `#f2f3f6` no claro (meta com `media`).
