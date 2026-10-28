import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: {
    // 0.0.0.0 = 允许局域网设备访问开发服务器
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    open: false,
    proxy: {
      // 局域网设备直连前端时，API 转发给本机后端（前端 API_BASE 为同源相对路径）
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        batch: 'batch.html',
        login: 'login.html',
        admin: 'admin.html',
      },
    },
  },
})
