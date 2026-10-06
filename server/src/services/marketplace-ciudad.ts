import { elegir, type MarketplaceCategory, type MarketplaceReply } from './marketplace-menu'

// ═══════════════════════════════════════════════════════════════════════════
// LA CIUDAD DEL CLIENTE (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Umbani se lanza en Chone y ya atiende en Portoviejo. Como las grandes, antes
// de enseñar nada hay que saber DÓNDE está el cliente: un cliente de Chone no
// puede ver los locales de Portoviejo.
//
// La regla, por orden:
//   1. La ciudad que ÉL eligió, si sigue teniendo locales.
//   2. La del local que tiene elegido ahora: quien está a mitad de un pedido
//      está en esa ciudad, y preguntarle ahí le cortaría el pedido.
//   3. Si solo UNA ciudad tiene locales, esa — sin preguntarle y SIN anotarla:
//      el día que abra otra, se le pregunta.
//   4. Si no, se le pregunta «¿En qué ciudad estás?».
//
// ⚠️ Todo esto son funciones PURAS. El paso que habla con el cliente
// (`atenderLaCiudad`) vive con los demás pasos del chat en
// `marketplace-entry.ts`, y las consultas del catálogo se atan a la ciudad con
// `conLaCiudad`: lo que viene después pide los locales de ESA ciudad sin saberlo.

/** Una fila de `marketplace_categories_disponibles`: una categoría EN una ciudad. */
export interface CategoriaEnCiudad extends MarketplaceCategory {
  city_id: string
  city_name: string
}

export interface CiudadConLocales {
  id: string
  nombre: string
}

/** Las ciudades con al menos un local, en el orden en que las da la base. */
export function ciudadesDe(filas: CategoriaEnCiudad[]): CiudadConLocales[] {
  const vistas = new Map<string, CiudadConLocales>()
  for (const fila of filas) {
    if (fila.city_id && !vistas.has(fila.city_id)) {
      vistas.set(fila.city_id, { id: fila.city_id, nombre: fila.city_name })
    }
  }
  return [...vistas.values()]
}

/**
 * La ciudad que se le enseña (la regla de arriba). `null` = hay que preguntar.
 */
export function ciudadEfectiva(
  ciudades: CiudadConLocales[],
  elegida: string | null | undefined,
  delLocalElegido: string | null | undefined,
): CiudadConLocales | null {
  const buscar = (id: string | null | undefined) => (id ? ciudades.find(c => c.id === id) ?? null : null)
  return buscar(elegida) ?? buscar(delLocalElegido) ?? (ciudades.length === 1 ? ciudades[0] : null)
}

/**
 * Las categorías de esa ciudad, con su nombre para el pie del menú. Sin
 * ciudad, ninguna.
 *
 * ⚠️ El nombre viaja EN cada categoría a propósito: `verCategorias` se llama
 * desde media docena de sitios (MENÚ, «Volver», «Empezar de nuevo»…) y así
 * todos pintan el «📍 Estás en Chone» sin que haya que acordarse en cada uno.
 */
export function categoriasDe(
  filas: CategoriaEnCiudad[],
  ciudad: CiudadConLocales | null,
  hayOtras: boolean,
): MarketplaceCategory[] {
  if (!ciudad) return []
  return filas
    .filter(fila => fila.city_id === ciudad.id)
    .map(fila => ({
      code: fila.code,
      label: fila.label,
      emoji: fila.emoji,
      locales: fila.locales,
      ciudad: ciudad.nombre,
      otrasCiudades: hayOtras,
    }))
}

const normalizar = (texto: string): string => texto
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+/g, ' ').trim().toLowerCase()

const COMANDOS_DE_CIUDAD = new Set([
  'ciudad', 'cambiar ciudad', 'cambiar de ciudad', 'otra ciudad', 'cambiar la ciudad', 'mi ciudad',
])

/** «CIUDAD», «cambiar de ciudad», «otra ciudad»… */
export function esComandoCiudad(texto: string): boolean {
  return COMANDOS_DE_CIUDAD.has(normalizar(texto))
}

/**
 * La ciudad que tocó en la lista o que escribió («chone», «Portoviejo»).
 *
 * ⚠️ Se reconoce el nombre EXACTO —sin tildes ni mayúsculas—, no un trozo:
 * «quiero algo en chone» es una búsqueda, y tratarlo como «me cambio de
 * ciudad» le cambiaría el menú sin que lo pidiera.
 */
export function ciudadEscrita(texto: string, ciudades: CiudadConLocales[]): CiudadConLocales | null {
  if (!ciudades.length) return null
  const porLista = elegir(texto, ciudades.map(c => c.nombre))
  if (porLista) return ciudades.find(c => c.nombre === porLista) ?? null
  const escrito = normalizar(texto)
  return ciudades.find(c => normalizar(c.nombre) === escrito) ?? null
}

/** «¿En qué ciudad estás?», con una opción por ciudad. */
export function preguntarCiudad(ciudades: CiudadConLocales[]): MarketplaceReply {
  return {
    reply: '📍 *¿En qué ciudad estás?*\n\nAsí te enseño los locales que te pueden llevar el pedido 👇',
    options: ciudades.map(c => c.nombre),
    vista: { vista: 'ciudades', pagina: 0 },
  }
}

/**
 * Ata la ciudad a las consultas del catálogo. Todo lo que viene después
 * —categorías, «¿hay abiertos?», búsqueda, la palabra que casa con un cajón—
 * pide los locales de ESA ciudad sin tener que pasarla a mano.
 *
 * ⚠️ Sin ciudad se pasa `null`, y la base no devuelve nada (falla cerrado).
 */
export function conLaCiudad<D extends {
  database: {
    getMarketplaceBusinesses(code: string, cityId?: string | null): Promise<unknown>
    searchMarketplaceBusinesses?(query: string, limite?: number, cityId?: string | null): Promise<unknown>
  }
}>(deps: D, ciudad: CiudadConLocales | null): D {
  const base = deps.database
  const cityId = ciudad?.id ?? null
  return {
    ...deps,
    database: {
      ...base,
      getMarketplaceBusinesses: (code: string) => base.getMarketplaceBusinesses(code, cityId),
      ...(base.searchMarketplaceBusinesses
        ? { searchMarketplaceBusinesses: (query: string, limite?: number) => base.searchMarketplaceBusinesses!(query, limite, cityId) }
        : {}),
    },
  }
}
