import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The renderer bundle. Served to the window from the app protocol (src/main/app-protocol.ts), so paths are relative.
export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    // The CSP allows only our own files: no inline module preload polyfill.
    modulePreload: { polyfill: false },
    sourcemap: true,
    // One chunk read from disk by the app window; splitting would not make it start faster.
    chunkSizeWarningLimit: 1024,
  },
});
