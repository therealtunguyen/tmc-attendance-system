import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Forward API calls to the Express server in dev.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
