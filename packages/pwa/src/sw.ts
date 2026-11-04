// Primeiro import: o zod precisa estar sem JIT antes dos schemas do shared (mesmo motivo do main.tsx).
import './zodJitless.js';
import type { PrecacheEntry } from 'workbox-precaching';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim, skipWaiting } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import {
  buildSessionUrl,
  OPEN_SESSION_MESSAGE,
  parseSessionTarget,
  type SessionTarget,
} from './push/notificationRoute.js';
import { notificationFromPush } from './push/payload.js';

// `self.__WB_MANIFEST` é o ponto de injeção do vite-plugin-pwa (lista do precache).
declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

// Mesmo comportamento do antigo generateSW com autoUpdate: a versão nova assume na hora.
skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navegação offline: qualquer rota do app cai no index.html do precache, exceto /api e /ws.
// Workbox compara a regex com a URL absoluta (url.href), por isso as regex incluem o host.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/api\//, /\/ws(?:[/?#]|$)/],
  }),
);

// API e WebSocket nunca passam por cache.
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/') || url.pathname === '/ws',
  new NetworkOnly(),
);

function readPushData(message: PushMessageData | null): unknown {
  if (message === null) return undefined;
  try {
    return message.json();
  } catch {
    return undefined;
  }
}

self.addEventListener('push', (event) => {
  const { title, options } = notificationFromPush(readPushData(event.data));
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Foca uma janela do app e manda a sessão para ela; sem janela, abre uma nova na URL da sessão. */
async function openSession(target: SessionTarget | null): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const [client] = windows;
  if (client !== undefined) {
    await client.focus();
    if (target !== null) {
      client.postMessage({ type: OPEN_SESSION_MESSAGE, ...target });
    }
    return;
  }
  await self.clients.openWindow(target === null ? '/' : buildSessionUrl(target));
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openSession(parseSessionTarget(event.notification.data)));
});
