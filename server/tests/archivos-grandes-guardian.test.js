import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { raiz } from './pantallas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// NINGÚN ARCHIVO DE CÓDIGO PASA DE 1.000 LÍNEAS
// ═══════════════════════════════════════════════════════════════════════════
//
// Regla del dueño (2026-10-06), antes de enseñarle el código a un programador
// de fuera: «nada de código espagueti, ni archivos de más de 1.000 líneas».
//
// Mil líneas no es un número mágico: es el punto a partir del cual un archivo
// casi siempre hace VARIAS cosas, y quien llega a tocar una tiene que leerlas
// todas. `marketplace-entry.ts` llegó a 1.968 juntando la entrada del chat, sus
// pantallas y sus frenos.
//
// Nació TRINQUETE el 2026-10-06: trece archivos pasaban y quedaron apuntados
// con su tamaño, para que pudieran encoger y nunca crecer. El 2026-10-08 se
// partió el último (`FoodStore.tsx`, 1.346) y la lista se retiró: la regla es
// ya ABSOLUTA. Un archivo que pasa se parte antes de fusionar; no hay lista de
// espera a la que volver a apuntarlo.
//
// Quedan fuera los archivos GENERADOS: `tipos-generados.ts` lo escribe
// `supabase gen types`, y partirlo a mano se perdería al regenerarlo.

const LIMITE = 1000

const GENERADOS = new Set(['server/src/db/tipos-generados.ts'])

const CODIGO = /\.(ts|tsx|js|mjs|cjs)$/
/** Lo que no es nuestro código: dependencias, compilados, informes. */
const SALTAR = new Set(['node_modules', 'dist', 'coverage', 'playwright-report', 'test-results', 'build'])

/** Todo el código del monorepo, con rutas «a/b/c.ts» desde la raíz. */
function codigoDelMonorepo(dir = '') {
  return readdirSync(path.join(raiz, dir), { withFileTypes: true }).flatMap((entrada) => {
    const ruta = dir ? `${dir}/${entrada.name}` : entrada.name
    if (entrada.isDirectory()) {
      // Las carpetas ocultas no son código, salvo los guiones del CI.
      const oculta = entrada.name.startsWith('.') && entrada.name !== '.github'
      return SALTAR.has(entrada.name) || oculta ? [] : codigoDelMonorepo(ruta)
    }
    return CODIGO.test(entrada.name) ? [ruta] : []
  })
}

/** Las líneas como las cuenta `wc -l`, más la última si no acaba en salto. */
const lineasDe = (texto) => (texto.match(/\n/g) || []).length + (texto && !texto.endsWith('\n') ? 1 : 0)

const tamanos = new Map(codigoDelMonorepo().map((archivo) => [
  archivo,
  lineasDe(readFileSync(path.join(raiz, archivo), 'utf8')),
]))

describe('ningún archivo de código pasa de 1.000 líneas', () => {
  it('ninguno pasa del límite', () => {
    const culpables = [...tamanos]
      .filter(([archivo, lineas]) => lineas > LIMITE && !GENERADOS.has(archivo))
      .map(([archivo, lineas]) => `${archivo} → ${lineas} líneas`)

    expect(culpables, `Pártelo por responsabilidades antes de seguir (máximo ${LIMITE}):\n${culpables.join('\n')}`)
      .toEqual([])
  })

  it('la excepción de los generados no apunta a archivos que ya no existen', () => {
    // Un generado renombrado que se queda en la lista es un hueco: el nombre
    // viejo ya no exime nada y el nuevo pasaría a contar sin que nadie lo vea.
    const fantasmas = [...GENERADOS]
      .filter((archivo) => !existsSync(path.join(raiz, archivo)))

    expect(fantasmas, `Sácalos de la lista:\n${fantasmas.join('\n')}`).toEqual([])
  })

  it('recorre de verdad el monorepo, y solo nuestro código', () => {
    // Un guardián que no mira nada pasa siempre en verde.
    expect(tamanos.size).toBeGreaterThan(400)
    for (const conocido of ['server/src/index.ts', 'apps/store/src/main.tsx', 'apps/admin/src/main.tsx', 'e2e/helpers.ts']) {
      expect(tamanos.has(conocido), conocido).toBe(true)
    }
    expect([...tamanos.keys()].filter((archivo) => /(^|\/)(node_modules|dist)\//.test(archivo))).toEqual([])
  })

  it('cuenta las líneas como wc -l', () => {
    expect(lineasDe('')).toBe(0)
    expect(lineasDe('una\ndos\n')).toBe(2)
    // Sin el salto final la última línea también existe.
    expect(lineasDe('una\ndos')).toBe(2)
  })
})
