import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'development-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.json', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.setHeader('Cache-Control', 'no-store');
        response.end(JSON.stringify({ mode: 'local', apiBaseUrl: '/api' }));
      });
    },
  }],
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { manifest: true },
});
