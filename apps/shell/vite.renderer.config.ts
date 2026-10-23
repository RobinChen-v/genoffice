import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// renderer-only build（供 HarmonyOS ArkWeb 移植使用；Electron 端走 electron.vite.config.ts）
// 只构建起始页 index.html —— update.html / pdf-password.html 是 Electron 专属弹窗（自动更新、
// PDF 密码提示），鸿蒙端暂不需要。需要时再加 rollupOptions.input 多入口。
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    port: Number(process.env.SHELL_DEV_PORT) || 5199,
    strictPort: true,
  },
})
