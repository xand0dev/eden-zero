import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and a relative base path for the bundled assets.
export default defineConfig({
  base: './',
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    fs: {
      // This checkout lives under a directory whose name contains `::`, which
      // breaks Vite's serving allow-list comparison: the dev server answers 403
      // "outside of Vite serving allow list" for its own index.html. The server
      // is bound to the loopback interface only, so relaxing the list is safe
      // here.
      strict: false,
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    // Vite empties the output directory with `fs.rmSync` before building, which
    // this machine's sandbox refuses ("SAFE_DELETE_BULK_CONFIRM_REQUIRED").
    // `scripts/build-app.sh` moves `dist` aside first, so there is never anything
    // to empty.
    emptyOutDir: false,
  },
  worker: {
    format: 'es',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
  },
} as never);
