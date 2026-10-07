import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL CÓDIGO DE LAS RUTAS DE LA TIENDA, ENTERO
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-10-07 el router de la tienda (`routes/storefront.routes.ts`)
// solo registra sus secciones, que viven en `routes/tienda/` (ningún archivo
// pasa de 1.000 líneas). Las pruebas que leen ese código como TEXTO lo leen
// entero aquí: si leyeran solo el archivo del router no encontrarían nada de
// lo que vigilan… y alguna pasaría en verde sin vigilar nada.

const servidor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** El router y todas sus secciones, en un solo texto. `compilado`: los .js de `dist/`. */
export function fuenteDeLaTienda({ compilado = false } = {}) {
  const base = path.join(servidor, compilado ? 'dist/routes' : 'src/routes')
  const extension = compilado ? '.js' : '.ts'
  const carpeta = path.join(base, 'tienda')
  const secciones = readdirSync(carpeta).filter(nombre => nombre.endsWith(extension)).sort()
  if (secciones.length < 5) throw new Error(`Faltan secciones de la tienda en ${carpeta}`)
  return [path.join(base, `storefront.routes${extension}`), ...secciones.map(nombre => path.join(carpeta, nombre))]
    .map(ruta => readFileSync(ruta, 'utf8'))
    .join('\n')
}
