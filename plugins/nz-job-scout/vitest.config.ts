import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['tests/runtime.test.mjs', 'node_modules/**'],
    coverage: { enabled: false },
  },
});
