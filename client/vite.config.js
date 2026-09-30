import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // In development the React app calls /api on its own origin; Vite forwards it to the Express backend.
  const backend = env.VITE_BACKEND_URL || 'http://localhost:5000';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/uploads': { target: backend, changeOrigin: true },
      },
    },
  };
});
