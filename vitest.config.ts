import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@parsers': resolve('src/parsers'),
      '@shared': resolve('src/shared'),
      '@bg': resolve('src/bg'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
