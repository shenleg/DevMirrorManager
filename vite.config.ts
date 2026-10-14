/** 配置桌面开发服务器、React 编译及用户操作测试环境。 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  clearScreen: false,
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], globals: true },
});
