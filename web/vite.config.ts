import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/console/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 3101,
    proxy: { '/console/api': 'http://localhost:3100' },
  },
});
