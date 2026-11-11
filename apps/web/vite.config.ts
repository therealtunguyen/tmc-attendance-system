import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'KIOSK_');
  return {
    plugins: [react()],
    server: {
      proxy: {
        // Kiosk decisions belong to the edge (#29); match before the central /api proxy.
        '/api/kiosk/scan': {
          target: env.KIOSK_EDGE_URL || 'http://127.0.0.1:3100',
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/api': 'http://localhost:3000',
      },
    },
  };
});
