/**
 * Texts the main process shows: the tray, status labels, messages sent to the control center, dialogs, notifications and the
 * pairing window. Brazilian Portuguese is the model of the other languages. Read through `t` / `translate`.
 *
 * A text that starts in lower case (`pairing.*`, `reasons.*`) is the tail of a longer message: "Não foi possível concluir
 * o pareamento: <text>". The log lines written to `desktop-daemon.log` are not here: they stay in Portuguese, for support.
 */
export const main = {
  status: {
    starting: 'Nanachi · iniciando',
    running: 'Nanachi · rodando',
    attached: 'Nanachi · conectado ao daemon existente',
    stopped: 'Nanachi · parado',
    error: 'Nanachi · erro',
  },
  dialogs: {
    title: 'Nanachi',
    missingUi: 'A interface do Nanachi não foi encontrada. Reinstale o aplicativo ou rode "npm run build:desktop -w @nanachi/desktop".',
    pairingCodeFailed: 'Não foi possível gerar o código de pareamento.',
    uninstallOnlyInstalled: 'O desinstalador só existe no Nanachi instalado.',
    pickFoldersTitle: 'Escolher pastas permitidas',
    pickFoldersButton: 'Adicionar',
  },
  notifications: {
    updateTitle: 'Nova versão do Nanachi',
    updateBody: 'A versão {{version}} está disponível. Clique para abrir a página da versão.',
  },
  tray: {
    open: 'Abrir Nanachi',
    openSessions: 'Abrir sessões',
    pairingCode: 'Gerar código de pareamento',
    startWithWindows: 'Iniciar com o Windows',
    quit: 'Sair',
  },
  pairingWindow: {
    windowTitle: 'Nanachi · Código de pareamento',
    pageTitle: 'Código de pareamento',
    codeLabel: 'Código {{code}}',
    qrAlt: 'QR do código {{code}}',
    qrHint: 'Escaneie com a câmera do celular para abrir o Nanachi e parear.',
    qrSetupHint: 'Conecte o Tailscale no painel do Nanachi para gerar um QR que abre no celular.',
    expiresIn: 'Expira em {{time}}',
    expired: 'Código expirado. Gere outro pelo ícone do Nanachi.',
    hint: 'No outro aparelho, abra o Nanachi, adicione uma máquina e digite o código. Uso único.',
  },
  control: {
    rejected: {
      accountsUnsupported: 'Este agente não tem contas extras.',
      accountInUse: 'Há uma sessão usando esta conta.',
      tooManyAccounts: 'O limite de contas deste agente foi atingido.',
      notFound: 'O agente ou a conta não foi encontrado.',
      refused: 'O daemon recusou o pedido.',
    },
    daemon: {
      unavailable: 'Não foi possível falar com o daemon do Nanachi. Ele pode estar parado ou ainda iniciando.',
      notPaired: 'Não foi possível parear o Nanachi Desktop com o daemon: {{detail}}',
      unauthorized: 'O daemon recusou o acesso do Nanachi Desktop; o dispositivo pode ter sido revogado. Tente de novo.',
      forbidden:
        'O daemon só aceita acessos pelo Tailscale (allowedTailscaleLogins no config.json), então o Nanachi Desktop não consegue consultá-lo. ' +
        'Deixe essa lista vazia no config.json da pasta de dados do Desktop.',
      notFound: 'O daemon não encontrou o que foi pedido.',
      busy: 'O daemon pediu calma: houve tentativas demais seguidas. Aguarde um instante e tente de novo.',
      server: 'O daemon respondeu com erro (HTTP {{status}}). Veja a aba Logs.',
      badResponse: 'O daemon respondeu algo que o Nanachi não entendeu. Ele pode ser de outra versão.',
    },
    pairingFailed: 'Não foi possível concluir o pareamento: {{detail}}',
    somethingWrong: 'Algo deu errado: {{detail}}',
    invalidId: 'Identificador inválido.',
    invalidFoldersRequest: 'Pedido inválido: a lista de pastas ou a opção de reiniciar não faz sentido.',
    oneFolderTooLong: 'Um dos caminhos é longo demais.',
    invalidBusyConfirmation: 'A confirmação de sessões em andamento é inválida.',
    daemonNotAvailable: 'O daemon não está disponível agora, então o Nanachi não consegue consultá-lo.',
    daemonNotRunning: 'O daemon não está rodando, então não dá para gerar um código agora.',
    restartNotOwn: 'O Nanachi está usando um daemon que ele não iniciou, então não pode reiniciá-lo por aqui.',
    foldersNotOwn: 'O Nanachi está conectado a um daemon que ele não iniciou; a lista de pastas dele não pode ser editada por aqui.',
    revokeThisApp: 'Este é o dispositivo que o próprio Nanachi Desktop usa; revogá-lo o desconectaria do daemon.',
    restartAttached: 'O daemon foi parado, mas outro programa já usava a porta e o Nanachi se conectou a ele em vez de iniciar o seu.',
    restartFailed: 'O daemon foi parado, mas não conseguiu iniciar de novo. Veja a aba Logs.',
    restartFailedDetail: 'O daemon foi parado, mas não conseguiu iniciar de novo. {{detail}} Veja a aba Logs.',
  },
  roots: {
    invalidList: 'A lista de pastas é inválida.',
    tooMany: 'Muitas pastas: o máximo é {{max}}.',
    pathTooLong: 'O caminho "{{path}}" é longo demais.',
    notAbsolute: '"{{path}}" não é um caminho absoluto do Windows (por exemplo, C:\\Projetos).',
    notFolder: '"{{path}}" não é uma pasta.',
    missing: 'A pasta "{{path}}" não existe.',
    timeout:
      'A pasta "{{path}}" não respondeu a tempo. Se ela está em uma rede ou em um disco desconectado, tente de novo quando estiver disponível.',
  },
  config: {
    readFailed: 'Não foi possível ler o config.json ({{file}}): {{detail}}',
    invalidJson: 'O config.json ({{file}}) não é um JSON válido: {{detail}}',
    notObject: 'O config.json ({{file}}) precisa ser um objeto JSON.',
    writeFailed: 'Não foi possível gravar o config.json ({{file}}): {{detail}}',
    prepareFailed: 'Não foi possível preparar o config.json em {{home}}: {{detail}}',
  },
  accounts: {
    principal: 'Conta principal',
  },
  reasons: {
    unknown: 'erro desconhecido',
    signal: 'sinal {{signal}}',
    exitCode: 'código {{code}}',
    processError: 'erro no processo: {{detail}}',
    spawnFailed: 'não foi possível iniciar: {{detail}}',
  },
  daemon: {
    restricted:
      'O daemon responde, mas só aceita acessos pelo Tailscale (allowedTailscaleLogins preenchido no config.json da pasta de dados do Desktop, .nanachi-desktop), ' +
      'então o painel local não consegue usá-lo. Deixe allowedTailscaleLogins vazio nesse config.json para usar o painel, ou abra o endereço do Tailscale.',
    runtimeMissing: 'Arquivo do runtime ausente: {{path}}',
    portBusy:
      'A porta {{port}} está ocupada por outro programa, que não é um daemon do Nanachi. ' +
      'Feche esse programa ou mude "port" no config.json de {{home}}; o Nanachi tenta de novo sozinho.',
    portCheckFailed: 'falha ao verificar a porta: {{detail}}',
    restartFailed: 'falha ao reiniciar o daemon: {{detail}}',
    notClosed: 'O daemon não respondeu e não pôde ser encerrado.',
    crashLoop: 'O daemon caiu {{count}} vezes em {{minutes}} minutos; o Nanachi parou de tentar. Último motivo: {{reason}}.',
    crashed: 'O daemon caiu ({{reason}}); tentando de novo em {{seconds}} s.',
  },
  tailscale: {
    locateFailed: 'Não foi possível localizar o Tailscale embutido: {{detail}}',
    programMissing: 'Não achei o programa do Tailscale embutido ({{name}}) em {{path}}.',
    stopped: 'O Tailscale embutido parou ({{reason}}).',
    retry: '{{message}} Tentando de novo em {{seconds}} s.',
  },
  updates: {
    githubUnreachable: 'Não foi possível consultar o GitHub: {{detail}}',
    githubHttp: 'O GitHub respondeu HTTP {{status}}.',
    githubUnreadable: 'Resposta do GitHub ilegível.',
  },
  uninstallLaunch: {
    failed: 'Não foi possível iniciar o desinstalador: {{detail}}',
    exitedWithCode: 'o PowerShell terminou com o código {{code}}',
    exitedWithError: 'o PowerShell terminou com erro',
  },
  pairing: {
    cliNothing: 'o comando de pareamento não imprimiu nada',
    cliNotJson: 'o comando de pareamento imprimiu algo que não é JSON',
    cliInvalid: 'resposta do comando de pareamento inválida',
    codeNotSixDigits: 'o código de pareamento não tem 6 dígitos',
    expiryInvalid: 'a validade do código de pareamento é inválida',
    deviceNothing: 'o comando de dispositivo não imprimiu nada',
    deviceNotJson: 'o comando de dispositivo imprimiu algo que não é JSON',
    deviceInvalid: 'resposta do comando de dispositivo inválida',
    deviceIncomplete: 'o comando de dispositivo não devolveu deviceId e token',
    noAnswer: 'o daemon não respondeu ao pareamento: {{detail}}',
    rateLimited: 'muitas tentativas de pareamento; aguarde um pouco',
    deviceRefused: 'o daemon recusou o novo dispositivo (HTTP {{status}})',
    badResponse: 'resposta de pareamento inválida',
    cliFailed: 'não foi possível rodar o comando de pareamento: {{detail}}',
    cliTimeout: 'o comando de pareamento demorou demais',
    cliExit: 'o comando de pareamento saiu com código {{code}}',
    onlyOwnDaemon: 'o Nanachi Desktop só se pareia com o daemon que ele mesmo iniciou',
    triedRecently: 'o pareamento do Nanachi Desktop foi tentado há pouco; aguarde um instante',
  },
} as const;
