// Primeiro import: o zod precisa estar sem JIT antes dos schemas do shared (mesmo motivo do main.tsx).
import './zodJitless.js';
import type { PrecacheEntry } from 'workbox-precaching';
import { cleanupOutdatedCaches, createHandlerBoundToURL, getCacheKeyForURL, precacheAndRoute } from 'workbox-precaching';
// `_private.cacheNames` é o nome que o próprio precache usa; a API pública não expõe o nome completo do cache.
import { _private, clientsClaim, skipWaiting } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';
import {
  buildDevicesUrl,
  buildSessionUrl,
  DEVICES_MESSAGE,
  OPEN_SESSION_MESSAGE,
  parseDevicesTarget,
  parseSessionTarget,
  type DevicesTarget,
  type SessionTarget,
} from './push/notificationRoute.js';
import { notificationFromPush } from './push/payload.js';
import { isRefillPrecacheRequest } from './updates/forceUpdate.js';

// `self.__WB_MANIFEST` é o ponto de injeção do vite-plugin-pwa (lista do precache).
declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

// Mesmo comportamento do antigo generateSW com autoUpdate: a versão nova assume na hora.
skipWaiting();
clientsClaim();

// The build injects the manifest at `self.__WB_MANIFEST`, and that injection point must occur exactly once.
const precacheManifest = self.__WB_MANIFEST;
precacheAndRoute(precacheManifest);
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

// "Forçar atualização" deletes the precache caches, and the precache only fills when the SW installs. This request
// refills the precache while the SW stays active (updates/forceUpdate.ts). It answers true once every file is back.
async function refillPrecache(): Promise<void> {
  const cache = await caches.open(_private.cacheNames.getPrecacheName());
  await Promise.all(
    precacheManifest.map(async (entry) => {
      const key = getCacheKeyForURL(typeof entry === 'string' ? entry : entry.url);
      if (key !== undefined) await cache.add(key);
    }),
  );
}

self.addEventListener('message', (event) => {
  if (!isRefillPrecacheRequest(event.data)) return;
  const [reply] = event.ports;
  if (reply === undefined) return;
  event.waitUntil(
    refillPrecache().then(
      () => reply.postMessage(true),
      () => reply.postMessage(false),
    ),
  );
});

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

/** Aviso de aparelho novo: foca a janela e manda para Dispositivos; sem janela, abre essa tela. */
async function openDevices(target: DevicesTarget): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const [client] = windows;
  if (client !== undefined) {
    await client.focus();
    client.postMessage({ type: DEVICES_MESSAGE, ...target });
    return;
  }
  await self.clients.openWindow(buildDevicesUrl(target));
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const devices = parseDevicesTarget(event.notification.data);
  event.waitUntil(
    devices !== null ? openDevices(devices) : openSession(parseSessionTarget(event.notification.data)),
  );
});
