import { defineConfig } from 'vitest/config';

// Testes com agente ACP real (fixture via tsx) levam mais que o padrão de 5 s.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
