// ═══════════════════════════════════════════════════════════════════════════
// LOS ICONOS DE LAS APPS INSTALABLES (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Dibuja los PNG que piden Android e iPhone para instalar `/u` (clientes) y
// `/r` (repartidores), con los MISMOS iconos de la tienda: la bolsa que ya sale
// en la bienvenida y la moto del repartidor. Cada app con su color, para que en
// un teléfono con las dos instaladas no se confundan.
//
// ⚠️ SON PROVISIONALES hasta que llegue el logo de Umbani. Ese día se cambia el
// `trazo` de cada marca por el del logo y se vuelve a correr:
//
//   npm run iconos
//
// Los PNG se guardan en el repositorio (`apps/store/public/iconos/`): el
// servidor de producción no tiene navegador para dibujarlos.

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destino = path.join(raiz, 'apps/store/public/iconos')

const LIMA = '#D9F950'
const TINTA = '#0B0B0C'

const MARCAS = {
  // RiShoppingBag3Line, la bolsa de la bienvenida de `u.html`.
  umbani: {
    fondo: LIMA,
    tinta: TINTA,
    trazo: 'M6.50488 2H17.5049C17.8196 2 18.116 2.14819 18.3049 2.4L21.0049 6V21C21.0049 21.5523 20.5572 22 20.0049 22H4.00488C3.4526 22 3.00488 21.5523 3.00488 21V6L5.70488 2.4C5.89374 2.14819 6.19013 2 6.50488 2ZM19.0049 8H5.00488V20H19.0049V8ZM18.5049 6L17.0049 4H7.00488L5.50488 6H18.5049ZM9.00488 10V12C9.00488 13.6569 10.348 15 12.0049 15C13.6617 15 15.0049 13.6569 15.0049 12V10H17.0049V12C17.0049 14.7614 14.7663 17 12.0049 17C9.24346 17 7.00488 14.7614 7.00488 12V10H9.00488Z',
  },
  // RiEBikeLine, la moto de la app del repartidor.
  repartidor: {
    fondo: TINTA,
    tinta: LIMA,
    trazo: 'M15.5006 6.93685C17.5926 8.14727 19 10.4093 19 13V21H14.8293C14.4175 22.1652 13.3062 23 12 23C10.6938 23 9.58254 22.1652 9.17071 21H5V13C5 10.4093 6.40741 8.14727 8.49936 6.93685C8.33754 6.645 8.21115 6.33078 8.12602 6H5V4H8.12602C8.57006 2.27477 10.1362 1 12 1C13.8638 1 15.4299 2.27477 15.874 4H19V6H15.874C15.7888 6.33078 15.6625 6.645 15.5006 6.93685ZM14.0474 8.43703C13.4484 8.79457 12.7482 9 12 9C11.2518 9 10.5516 8.79457 9.95263 8.43703C8.21207 9.21922 7 10.9681 7 13V19H9V15C9 13.3431 10.3431 12 12 12C13.6569 12 15 13.3431 15 15V19H17V13C17 10.9681 15.7879 9.21922 14.0474 8.43703ZM12 14C11.4477 14 11 14.4477 11 15V20C11 20.5523 11.4477 21 12 21C12.5523 21 13 20.5523 13 20V15C13 14.4477 12.5523 14 12 14ZM12 7C13.1046 7 14 6.10457 14 5C14 3.89543 13.1046 3 12 3C10.8954 3 10 3.89543 10 5C10 6.10457 10.8954 7 12 7Z',
  },
}

// Las tres formas que piden los sistemas:
//  · `any`: esquinas redondeadas y transparentes, como un icono de app.
//  · `maskable`: a sangre. Android lo recorta con SU forma (círculo, gota…) y
//    solo garantiza el círculo central del 80 %: el dibujo va más pequeño.
//  · `apple`: a sangre también; el iPhone redondea las esquinas él mismo y
//    pinta de negro cualquier transparencia.
const FORMAS = [
  { sufijo: '192', lado: 192, radio: 0.22, dibujo: 0.58 },
  { sufijo: '512', lado: 512, radio: 0.22, dibujo: 0.58 },
  { sufijo: 'maskable-512', lado: 512, radio: 0, dibujo: 0.46 },
  { sufijo: '180', lado: 180, radio: 0, dibujo: 0.58 },
]

const lienzo = ({ fondo, tinta, trazo }, { lado, radio, dibujo }) => {
  const tamano = Math.round(lado * dibujo)
  const margen = Math.round((lado - tamano) / 2)
  return `<!doctype html><html><body style="margin:0;background:transparent">
    <svg xmlns="http://www.w3.org/2000/svg" width="${lado}" height="${lado}" viewBox="0 0 ${lado} ${lado}">
      <rect width="${lado}" height="${lado}" rx="${Math.round(lado * radio)}" fill="${fondo}"/>
      <svg x="${margen}" y="${margen}" width="${tamano}" height="${tamano}" viewBox="0 0 24 24">
        <path d="${trazo}" fill="${tinta}"/>
      </svg>
    </svg></body></html>`
}

mkdirSync(destino, { recursive: true })
const navegador = await chromium.launch()
try {
  for (const [nombre, marca] of Object.entries(MARCAS)) {
    for (const forma of FORMAS) {
      const pagina = await navegador.newPage({ viewport: { width: forma.lado, height: forma.lado } })
      await pagina.setContent(lienzo(marca, forma))
      const archivo = path.join(destino, `${nombre}-${forma.sufijo}.png`)
      await pagina.screenshot({ path: archivo, omitBackground: forma.radio > 0 })
      await pagina.close()
      console.log(`✅ ${path.relative(raiz, archivo)}`)
    }
  }
} finally {
  await navegador.close()
}
