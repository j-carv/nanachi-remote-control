import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { atomicWatchOutput } from './build/atomic-output.js';

const DAEMON_TARGET = 'http://127.0.0.1:7777';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Service worker próprio (src/sw.ts): precache + navegação offline + handlers de push.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Nanachi Remote',
        short_name: 'Nanachi Remote',
        description: 'Controle remoto dos agentes de IA no seu PC.',
        lang: 'pt-BR',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#0e1116',
        background_color: '#0e1116',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
    atomicWatchOutput(),
  ],
  server: {
    proxy: {
      '/api': { target: DAEMON_TARGET },
      '/ws': { target: DAEMON_TARGET, ws: true },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
  },
});
