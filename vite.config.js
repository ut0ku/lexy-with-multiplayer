import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api-docs': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        secure: false
      },
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        secure: false
      },
      '/mp-api-docs': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        secure: false
      },
      '/mp-api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/mp-api/, '/api')
      },
      '/socket.io': {
        target: 'http://localhost:3002',
        ws: true,
        secure: false
      }
    }
  }
});