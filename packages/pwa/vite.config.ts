import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import { atomicWatchOutput, currentBuildDir } from './build/atomic-output.js';
import { keepBuildEntries } from './build/release-check.js';

const DAEMON_TARGET = 'http://127.0.0.1:7777';

/** Build id for the "Forçar atualização" drawer: the short git hash, or a timestamp when git is not available. */
function buildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return Date.now().toString(36);
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,webmanifest}'],
        // The output folder keeps chunks of earlier builds; precache only the files of this build (build/release-check.ts).
        manifestTransforms: [keepBuildEntries(currentBuildDir)],
      },
      devOptions: { enabled: false },
    }),
    atomicWatchOutput(),
  ],
  resolve: {
    // Alias do shadcn/ui (`@/components/ui/...`), igual ao `paths` do tsconfig.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Build id, read by updates/buildInfo.ts. Takes effect after the pwa-vite watch build restarts.
  define: { __APP_BUILD__: JSON.stringify(buildId()) },
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
