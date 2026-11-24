import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src'), '@shared': path.resolve(import.meta.dirname, 'shared') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT ?? 4000}`, changeOrigin: false },
      '/uploads': { target: `http://localhost:${process.env.PORT ?? 4000}`, changeOrigin: false },
    },
  },
  build: { chunkSizeWarningLimit: 1500 },
});
