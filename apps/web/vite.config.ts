import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The SPA is served by Caddy in the container (ADR-011) and proxies /api to the
 * backend. In development Vite proxies the same path, so the app cannot tell the
 * difference and no environment-specific base URL is needed.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VANTAGEPOINT_WEB_PORT ?? 5173),
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
