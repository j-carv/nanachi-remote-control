/** O que o navegador expõe; a UI passa o valor real, os testes passam fakes. */
export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}

/**
 * Web Push disponível: precisa de service worker, PushManager e Notification.
 * No iPhone isso só existe quando o app foi aberto pelo ícone da Tela de Início (iOS 16.4+).
 */
export function isPushSupported(env: PushEnvironment): boolean {
  return env.hasServiceWorker && env.hasPushManager && env.hasNotification;
}
