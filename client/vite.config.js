import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Локально для разработки с работающими /api-функциями используйте
// `vercel dev` (Vercel CLI) вместо обычного `vite dev` — он эмулирует
// serverless-функции из папки api/ вместе с фронтендом на одном порту.
// Обычный `npm run dev` (просто Vite) отлично подходит для правки
// вёрстки/интерфейса, но запросы к /api будут возвращать 404, пока
// не запущено через `vercel dev`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
