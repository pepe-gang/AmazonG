import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@browser': resolve('src/browser'),
        '@actions': resolve('src/actions'),
        '@workflows': resolve('src/workflows'),
        '@parsers': resolve('src/parsers'),
        '@bg': resolve('src/bg'),
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@parsers': resolve('src/parsers'),
        // shadcn/ui default alias root — mirrors Bestie's components.json
        // so the shadcn CLI can add future components without extra
        // config. All new UI code lives under src/renderer/.
        '@': resolve('src/renderer'),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});
