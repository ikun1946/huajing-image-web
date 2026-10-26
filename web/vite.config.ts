import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        studio: 'index.html',
        batch: 'batch.html',
        login: 'login.html',
        admin: 'admin.html',
      },
    },
  },
})
