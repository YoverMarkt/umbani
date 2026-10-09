import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL CÓDIGO DE UN ROUTER PARTIDO, ENTERO
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-10-07 los routers grandes solo registran sus secciones, que
// viven en una carpeta propia (ningún archivo pasa de 1.000 líneas): la tienda
// en `routes/tienda/`, los locales del superadmin en `routes/locales/`. Las
// pruebas que leen ese código como TEXTO lo leen entero aquí: si leyeran solo
// el archivo del router no encontrarían nada de lo que vigilan… y las que
// comprueban que algo NO está pasarían en verde sin mirar.

const servidor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Los archivos del router y de sus secciones. `compilado`: los .js de `dist/`. */
export function archivosDeRutas(router, carpeta, { compilado = false } = {}) {
  const base = path.join(servidor, compilado ? 'dist/routes' : 'src/routes')
  const extension = compilado ? '.js' : '.ts'
  const dir = path.join(base, carpeta)
  const secciones = readdirSync(dir).filter(nombre => nombre.endsWith(extension)).sort()
  if (secciones.length < 2) throw new Error(`Faltan las secciones de ${router} en ${dir}`)
  return [path.join(base, `${router}${extension}`), ...secciones.map(nombre => path.join(dir, nombre))]
}

/** Todo el código del router y sus secciones, en un solo texto. */
export const fuenteDeRutas = (router, carpeta, opciones) =>
  archivosDeRutas(router, carpeta, opciones).map(ruta => readFileSync(ruta, 'utf8')).join('\n')

export const fuenteDeLaTienda = opciones => fuenteDeRutas('storefront.routes', 'tienda', opciones)
export const fuenteDeLasRutasDeLocales = opciones => fuenteDeRutas('admin-clients.routes', 'locales', opciones)

/**
 * La entrada del marketplace entera (2026-10-07): el orquestador y las cuatro
 * partes que se separaron de él (tipos, recorrido, comandos y enlace).
 */
export const fuenteDeLaEntradaDelMarketplace = () => [
  'marketplace-entry', 'marketplace-entry-tipos', 'marketplace-recorrido', 'marketplace-comandos', 'marketplace-enlace',
].map(nombre => readFileSync(path.join(servidor, 'src/services', `${nombre}.ts`), 'utf8')).join('\n')
