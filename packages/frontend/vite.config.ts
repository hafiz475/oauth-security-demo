/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:3000';

// In dev the browser only talks to :5173; these prefixes are forwarded to the
// backend. SPA routes (/oauth/meta/callback, /oauth/callback/:provider) are
// not proxied, only the JSON endpoints under them.
const proxied = [
  '/session',
  '/providers',
  '/connections',
  '/oauth/popup',
  '/oauth/redirect',
  '/oauth/embedded',
  '^/oauth/callback/[^/]+/(start|verify-state|exchange)$',
  '/google-oauth2',
  '/integration',
  '/meta/',
  '/mock-oauth',
  '/health',
];

export default defineConfig({
  plugins: [react()],
  // Shares the root .env; Vite exposes only VITE_* variables to the bundle.
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(proxied.map((p) => [p, { target: backend }])),
  },
  test: {
    name: 'frontend',
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:5173/' } },
    setupFiles: ['tests/setup.ts'],
  },
});
