import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000,
    hookTimeout: 120000,
    include: ['fixtures/**/test/**/*.{test,spec}.ts'],
  },
});
