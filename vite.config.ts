import { defineConfig } from 'vite';

// Development: the client runs on 5190 and Vite proxies the API and the socket to the office server,
// which listens on AFFICE_PORT (default 4747), so the browser talks to one origin. The built client
// (dist/client) is served by the office server itself, on the same port as the API.
const OFFICE_PORT = Number(process.env.AFFICE_PORT ?? 4747);
const CLIENT_PORT = 5190;

// The office server trusts one page origin besides its own: the Vite page, named to the server by
// AFFICE_DEV_ORIGIN=http://localhost:5190. `npm run server` and start.sh set it; a server started by hand
// needs it too, or it refuses this page. The page gets its token from GET /api/session through the proxy.
export const DEV_ORIGIN = `http://localhost:${CLIENT_PORT}`;

export default defineConfig({
  root: '.',
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${OFFICE_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${OFFICE_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // The office is one view with three.js in it: one 600 kB chunk is expected.
    chunkSizeWarningLimit: 900,
  },
});
