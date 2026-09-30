import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const apiPort = process.env.VCKB_PORT || '8787';

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // No data: URIs (the CSP only allows data: for images) and no inline preload polyfill.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin API in development too: no CORS. changeOrigin stays false so the browser's Host
      // (localhost:5173) reaches the server and matches the Origin in the CSRF check.
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
});
