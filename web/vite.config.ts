import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/workbench/',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
});
