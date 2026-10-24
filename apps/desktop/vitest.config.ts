import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Main-process modules run on Node; renderer components run in jsdom with Testing Library.
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      { extends: true, test: { name: 'main', include: ['test/main/**/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'renderer', include: ['test/renderer/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['test/renderer/setup.ts'] } },
    ],
  },
});
