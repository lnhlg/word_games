import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // 显式绑 IPv4：默认的 localhost 在 Windows 上会落到 ::1，
    // 导致 127.0.0.1 访问不到。
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
    watch: {
      // 前端只需要 watch src/web、src/shared 与 index.html。
      // 后端代码（src/server、src/tavern）不参与 HMR，但它和前端同在一棵树里，
      // 默认会被 chokidar 盯上——agent/编辑器写这些文件时 chokidar 会撞 EBUSY，
      // 把整个 dev server 拖崩。票、文档、数据库与临时文件同理。
      ignored: [
        '**/.scratch/**',
        '**/data/**',
        '**/docs/**',
        '**/src/server/**',
        '**/src/tavern/**',
        /\.tmpdir/,
        /\.tmp$/,
      ],
    },
  },
  build: {
    outDir: 'dist',
  },
})
