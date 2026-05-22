import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3500', changeOrigin: true },
      '/admin': { target: 'http://localhost:3500', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3500', ws: true },
      '/bridge': { target: 'http://localhost:3500', changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('monaco-editor')) return 'editor';
          if (id.includes('react-markdown') || id.includes('remark-') || id.includes('rehype-') || id.includes('micromark') || id.includes('mdast')) return 'markdown';
          if (id.includes('react-dom') || id.includes('/react/') || id.includes('scheduler') || id.includes('react-router')) return 'vendor-react';
          if (id.includes('lucide-react') || id.includes('@radix-ui') || id.includes('framer-motion')) return 'vendor-ui';
          return 'vendor';
        },
      },
    },
  },
});
