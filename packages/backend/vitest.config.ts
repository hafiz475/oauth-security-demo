import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'backend',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
    setupFiles: ['tests/setup.ts'],
  },
});
