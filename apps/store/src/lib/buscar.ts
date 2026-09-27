import type { Product } from './types'

// ═══════════════════════════════════════════════════════════════════════════
// BUSCAR EN LA CARTA
// ═══════════════════════════════════════════════════════════════════════════
//
// La pantalla de Buscar (2026-09-26) pinta; esto decide QUÉ sale y en qué
// orden. Vive aparte para poder probarlo sin pantalla.

/** Para buscar «jamon» y que salga «jamón». Nadie escribe tildes con una mano. */
export const normalizar = (texto: string) =>
  texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

export interface GrupoDeCarta {
  id: string
  nombre: string
  imagen: string | null
  productos: Product[]
}

export interface Hallazgo<G extends GrupoDeCarta = GrupoDeCarta> {
  grupo: G
  productos: Product[]
}

/**
 * Los productos que casan con lo que escribió el cliente, agrupados por su
 * sección de la carta.
 *
 * ⚠️ PALABRA POR PALABRA, no la frase entera. Con la frase entera,
 * «pizza pepperoni» no encontraba «Pepperoni pizza familiar», y es justo lo
 * que escribe quien ya sabe lo que quiere.
 *
 * ⚠️ El NOMBRE DE LA SECCIÓN también cuenta: «bebidas» trae las bebidas
 * aunque ninguna lo diga en su nombre.
 *
 * El orden: primero lo que EMPIEZA por lo escrito, luego lo que lo lleva en
 * el nombre, y al final lo que solo lo menciona en la descripción o la
 * sección. Lo agotado baja, pero no desaparece: si el cliente lo busca por su
 * nombre, decirle que hoy no hay es mejor que dejarle creer que nunca hubo.
 */
export function buscarEnLaCarta<G extends GrupoDeCarta>(
  grupos: G[],
  consulta: string,
): Hallazgo<G>[] {
  const frase = normalizar(consulta)
  const palabras = frase.split(/\s+/).filter(Boolean)
  if (!palabras.length) return []

  const porGrupo = grupos.map((grupo, ordenDelGrupo) => {
    const seccion = normalizar(grupo.nombre)
    const hallados = grupo.productos.flatMap((producto, orden) => {
      const nombre = normalizar(producto.name)
      const todo = `${nombre} ${normalizar(producto.description || '')} ${seccion}`
      if (!palabras.every(palabra => todo.includes(palabra))) return []
      const puntos = nombre.startsWith(frase) ? 0
        : palabras.every(palabra => nombre.includes(palabra)) ? 1
          : 2
      return [{ producto, puntos: puntos + (producto.available ? 0 : 3), orden }]
    })
    hallados.sort((a, b) => a.puntos - b.puntos || a.orden - b.orden)
    const mejor = hallados.length ? hallados[0].puntos : Infinity
    return { grupo, productos: hallados.map(h => h.producto), mejor, ordenDelGrupo }
  })

  return porGrupo
    .filter(resultado => resultado.productos.length)
    // La sección con el mejor acierto va primero; a igualdad, la de la carta.
    .sort((a, b) => a.mejor - b.mejor || a.ordenDelGrupo - b.ordenDelGrupo)
    .map(({ grupo, productos }) => ({ grupo, productos }))
}

// ── Lo que buscó antes, en este teléfono ────────────────────────────────────
//
// ⚠️ Es una comodidad del teléfono, no un dato: vive en `localStorage`, por
// local, y TODO acceso va en try/catch. En modo privado, o con el
// almacenamiento bloqueado, el acceso lanza, y la pantalla de Buscar tiene que
// abrirse igual, simplemente sin recientes.

const MAXIMO_RECIENTES = 5
const clave = (slug: string) => `busquedas:${slug}`

export function leerRecientes(slug: string): string[] {
  try {
    const guardado: unknown = JSON.parse(localStorage.getItem(clave(slug)) || '[]')
    return Array.isArray(guardado)
      ? guardado.filter((x): x is string => typeof x === 'string').slice(0, MAXIMO_RECIENTES)
      : []
  } catch {
    return []
  }
}

export function guardarReciente(slug: string, consulta: string): string[] {
  const limpia = consulta.trim().slice(0, 60)
  if (limpia.length < 2) return leerRecientes(slug)
  const lista = [
    limpia,
    ...leerRecientes(slug).filter(anterior => normalizar(anterior) !== normalizar(limpia)),
  ].slice(0, MAXIMO_RECIENTES)
  try {
    localStorage.setItem(clave(slug), JSON.stringify(lista))
  } catch { /* sin almacenamiento, sin recientes: la búsqueda funciona igual */ }
  return lista
}

export function borrarRecientes(slug: string): void {
  try {
    localStorage.removeItem(clave(slug))
  } catch { /* nada que borrar donde no se puede guardar */ }
}
