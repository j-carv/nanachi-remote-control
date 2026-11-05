import type { Strings } from '../../types.js';
import type { main as ptBR } from '../pt-BR/main.js';

/** Texts the main process shows, Spanish (neutral Latin American, "tú"). Same keys as pt-BR. */
export const main: Strings<typeof ptBR> = {
  status: {
    starting: 'Nanachi · iniciando',
    running: 'Nanachi · en ejecución',
    attached: 'Nanachi · conectado al daemon existente',
    stopped: 'Nanachi · detenido',
    error: 'Nanachi · error',
  },
  dialogs: {
    title: 'Nanachi',
    missingUi: 'No se encontró la interfaz de Nanachi. Reinstala la aplicación o ejecuta "npm run build:desktop -w @nanachi/desktop".',
    pairingCodeFailed: 'No se pudo generar el código de emparejamiento.',
    uninstallOnlyInstalled: 'El desinstalador solo existe en el Nanachi instalado.',
    pickFoldersTitle: 'Elegir carpetas permitidas',
    pickFoldersButton: 'Agregar',
  },
  notifications: {
    updateTitle: 'Nueva versión de Nanachi',
    updateBody: 'La versión {{version}} está disponible. Haz clic para abrir la página de la versión.',
  },
  tray: {
    open: 'Abrir Nanachi',
    openSessions: 'Abrir sesiones',
    pairingCode: 'Generar código de emparejamiento',
    startWithWindows: 'Iniciar con Windows',
    quit: 'Salir',
  },
  pairingWindow: {
    windowTitle: 'Nanachi · Código de emparejamiento',
    pageTitle: 'Código de emparejamiento',
    codeLabel: 'Código {{code}}',
    qrAlt: 'QR del código {{code}}',
    expiresIn: 'Expira en {{time}}',
    expired: 'Código expirado. Genera otro desde el ícono de Nanachi.',
    hint: 'En el otro dispositivo, abre Nanachi, agrega una máquina y escribe el código. De un solo uso.',
  },
  control: {
    rejected: {
      accountsUnsupported: 'Este agente no tiene cuentas adicionales.',
      accountInUse: 'Hay una sesión usando esta cuenta.',
      tooManyAccounts: 'Se alcanzó el límite de cuentas de este agente.',
      notFound: 'No se encontró el agente o la cuenta.',
      refused: 'El daemon rechazó la solicitud.',
    },
    daemon: {
      unavailable: 'No se pudo comunicar con el daemon de Nanachi. Puede estar detenido o aún iniciando.',
      notPaired: 'No se pudo emparejar Nanachi Desktop con el daemon: {{detail}}',
      unauthorized: 'El daemon rechazó el acceso de Nanachi Desktop; el dispositivo pudo haber sido revocado. Inténtalo de nuevo.',
      forbidden:
        'El daemon solo acepta accesos por Tailscale (allowedTailscaleLogins en config.json), así que Nanachi Desktop no puede consultarlo. ' +
        'Deja esa lista vacía en el config.json de la carpeta de datos de Desktop.',
      notFound: 'El daemon no encontró lo que se pidió.',
      busy: 'El daemon pidió calma: hubo demasiados intentos seguidos. Espera un momento e inténtalo de nuevo.',
      server: 'El daemon respondió con un error (HTTP {{status}}). Mira la pestaña Registros.',
      badResponse: 'El daemon respondió algo que Nanachi no entendió. Puede ser de otra versión.',
    },
    pairingFailed: 'No se pudo completar el emparejamiento: {{detail}}',
    somethingWrong: 'Algo salió mal: {{detail}}',
    invalidId: 'Identificador no válido.',
    invalidFoldersRequest: 'Solicitud no válida: la lista de carpetas o la opción de reiniciar no tiene sentido.',
    oneFolderTooLong: 'Una de las rutas es demasiado larga.',
    invalidBusyConfirmation: 'La confirmación de las sesiones en curso no es válida.',
    daemonNotAvailable: 'El daemon no está disponible ahora, así que Nanachi no puede consultarlo.',
    daemonNotRunning: 'El daemon no está en ejecución, así que no se puede generar un código ahora.',
    restartNotOwn: 'Nanachi está usando un daemon que no inició, así que no puede reiniciarlo desde aquí.',
    foldersNotOwn: 'Nanachi está conectado a un daemon que no inició; su lista de carpetas no se puede editar desde aquí.',
    revokeThisApp: 'Este es el dispositivo que usa el propio Nanachi Desktop; revocarlo lo desconectaría del daemon.',
    restartAttached: 'El daemon se detuvo, pero otro programa ya usaba el puerto y Nanachi se conectó a él en lugar de iniciar el suyo.',
    restartFailed: 'El daemon se detuvo, pero no pudo iniciar de nuevo. Mira la pestaña Registros.',
    restartFailedDetail: 'El daemon se detuvo, pero no pudo iniciar de nuevo. {{detail}} Mira la pestaña Registros.',
  },
  roots: {
    invalidList: 'La lista de carpetas no es válida.',
    tooMany: 'Demasiadas carpetas: el máximo es {{max}}.',
    pathTooLong: 'La ruta "{{path}}" es demasiado larga.',
    notAbsolute: '"{{path}}" no es una ruta absoluta de Windows (por ejemplo, C:\\Proyectos).',
    notFolder: '"{{path}}" no es una carpeta.',
    missing: 'La carpeta "{{path}}" no existe.',
    timeout:
      'La carpeta "{{path}}" no respondió a tiempo. Si está en una red o en un disco desconectado, inténtalo de nuevo cuando esté disponible.',
  },
  config: {
    readFailed: 'No se pudo leer config.json ({{file}}): {{detail}}',
    invalidJson: 'config.json ({{file}}) no es un JSON válido: {{detail}}',
    notObject: 'config.json ({{file}}) debe ser un objeto JSON.',
    writeFailed: 'No se pudo guardar config.json ({{file}}): {{detail}}',
    prepareFailed: 'No se pudo preparar config.json en {{home}}: {{detail}}',
  },
  accounts: {
    principal: 'Cuenta principal',
  },
  reasons: {
    unknown: 'error desconocido',
    signal: 'señal {{signal}}',
    exitCode: 'código de salida {{code}}',
    processError: 'error del proceso: {{detail}}',
    spawnFailed: 'no se pudo iniciar: {{detail}}',
  },
  daemon: {
    restricted:
      'El daemon responde, pero solo acepta accesos por Tailscale (allowedTailscaleLogins tiene valores en el config.json de la carpeta de datos de Desktop, .nanachi-desktop), ' +
      'así que el panel local no puede usarlo. Deja allowedTailscaleLogins vacío en ese config.json para usar el panel, o abre la dirección de Tailscale.',
    runtimeMissing: 'Falta un archivo del runtime: {{path}}',
    portBusy:
      'El puerto {{port}} está ocupado por otro programa, que no es un daemon de Nanachi. ' +
      'Cierra ese programa o cambia "port" en el config.json de {{home}}; Nanachi lo intenta de nuevo por sí solo.',
    portCheckFailed: 'Error al verificar el puerto: {{detail}}',
    restartFailed: 'Error al reiniciar el daemon: {{detail}}',
    notClosed: 'El daemon no respondió y no se pudo detener.',
    crashLoop: 'El daemon falló {{count}} veces en {{minutes}} min; Nanachi dejó de intentarlo. Último motivo: {{reason}}.',
    crashed: 'El daemon falló ({{reason}}); reintentando en {{seconds}} s.',
  },
  tailscale: {
    locateFailed: 'No se pudo localizar el Tailscale integrado: {{detail}}',
    programMissing: 'No se encontró el programa del Tailscale integrado ({{name}}) en {{path}}.',
    stopped: 'El Tailscale integrado se detuvo ({{reason}}).',
    retry: '{{message}} Reintentando en {{seconds}} s.',
  },
  updates: {
    githubUnreachable: 'No se pudo consultar GitHub: {{detail}}',
    githubHttp: 'GitHub respondió HTTP {{status}}.',
    githubUnreadable: 'No se pudo leer la respuesta de GitHub.',
  },
  uninstallLaunch: {
    failed: 'No se pudo iniciar el desinstalador: {{detail}}',
    exitedWithCode: 'PowerShell terminó con el código {{code}}',
    exitedWithError: 'PowerShell terminó con un error',
  },
  pairing: {
    cliNothing: 'el comando de emparejamiento no imprimió nada',
    cliNotJson: 'el comando de emparejamiento imprimió algo que no es JSON',
    cliInvalid: 'respuesta no válida del comando de emparejamiento',
    codeNotSixDigits: 'el código de emparejamiento no tiene 6 dígitos',
    expiryInvalid: 'la vigencia del código de emparejamiento no es válida',
    deviceNothing: 'el comando de dispositivo no imprimió nada',
    deviceNotJson: 'el comando de dispositivo imprimió algo que no es JSON',
    deviceInvalid: 'respuesta no válida del comando de dispositivo',
    deviceIncomplete: 'el comando de dispositivo no devolvió deviceId ni token',
    noAnswer: 'el daemon no respondió a la solicitud de emparejamiento: {{detail}}',
    rateLimited: 'demasiados intentos de emparejamiento; espera un momento',
    deviceRefused: 'el daemon rechazó el nuevo dispositivo (HTTP {{status}})',
    badResponse: 'respuesta de emparejamiento no válida',
    cliFailed: 'no se pudo ejecutar el comando de emparejamiento: {{detail}}',
    cliTimeout: 'el comando de emparejamiento tardó demasiado',
    cliExit: 'el comando de emparejamiento terminó con el código {{code}}',
    onlyOwnDaemon: 'Nanachi Desktop solo se empareja con el daemon que él mismo inició',
    triedRecently: 'el emparejamiento de Nanachi Desktop se intentó hace poco; espera un momento',
  },
};
