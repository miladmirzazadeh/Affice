import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVICE = process.env.TRELLA_URL ?? 'http://127.0.0.1:4174';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // Contributors run `npm run dev` here against a `trella start` service.
    proxy: {
      '/api': {
        target: SERVICE,
        changeOrigin: false,
        // The event stream must not be buffered by the dev proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The board is one view; a second chunk would only add a request.
    chunkSizeWarningLimit: 900,
  },
});
