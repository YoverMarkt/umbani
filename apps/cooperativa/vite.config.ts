import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Panel de las COOPERATIVAS DE REPARTO (2026-10-06), en Express en /cooperativa.
// Como el del local y el del superadmin: React + shadcn de `packages/ui`.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), tailwindcss()],
  base: '/cooperativa/',
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
})
