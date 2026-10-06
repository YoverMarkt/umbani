import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Mini app del negocio (la tienda que abre el cliente desde WhatsApp).
//
// - base '/t/': la URL viaja en un mensaje de WhatsApp, así que es corta. Al
//   ser absoluta, los assets resuelven igual en /t/slug que en /t/otro-slug.
// - Sin router ni cliente de datos: esto se abre con datos móviles y en
//   teléfonos modestos, así que cada kilobyte del bundle se paga en clientes
//   que cierran la app antes de que cargue.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  plugins: [react(), tailwindcss()],
  base: '/t/',
  // Tres páginas (2026-10-05): la tienda de siempre (`index.html`, la que abre
  // WhatsApp), la app web de clientes (`u.html`, servida en `/u`) y la de
  // repartidores (`r.html`, en `/r`). El manifiesto le dice al presupuesto qué
  // descarga CADA una: quien abre una tienda no carga las apps, y no puede
  // pagar su peso.
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        umbani: path.resolve(__dirname, 'u.html'),
        repartidor: path.resolve(__dirname, 'r.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
