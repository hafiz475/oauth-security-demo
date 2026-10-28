import { defineConfig } from 'vitest/config';

// One suite, two projects. `pnpm test` runs both and prints a single total.
export default defineConfig({
  test: {
    projects: ['packages/backend', 'packages/frontend'],
  },
});
