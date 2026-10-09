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
// ⚠️ ES UN TRINQUETE. Los archivos que ya pasaban el día que nació el guardián
// están apuntados abajo con su tamaño de ese día: pueden ENCOGER, nunca
// crecer. Si hay que tocar uno, primero se parte. Y el día que baja del límite
// hay que sacarlo de la lista, para que no vuelva a engordar a escondidas: la
// lista solo se acorta.
//
// Quedan fuera los archivos GENERADOS: `tipos-generados.ts` lo escribe
// `supabase gen types`, y partirlo a mano se perdería al regenerarlo.

const LIMITE = 1000

/** Los que ya pasaban el 2026-10-06, con sus líneas de ese día. Solo encogen. */
const PENDIENTES_DE_PARTIR = {
  'apps/store/src/screens/FoodStore.tsx': 1346,
  'apps/client/src/features/catalog/OptionsManager.tsx': 1307,
  'apps/store/src/components/ProductSheet.tsx': 1018,
  'apps/client/src/features/orders/Orders.tsx': 1011,
}

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
  it('ninguno nuevo pasa del límite', () => {
    const culpables = [...tamanos]
      .filter(([archivo, lineas]) => lineas > LIMITE && !(archivo in PENDIENTES_DE_PARTIR) && !GENERADOS.has(archivo))
      .map(([archivo, lineas]) => `${archivo} → ${lineas} líneas`)

    expect(culpables, `Pártelo por responsabilidades antes de seguir (máximo ${LIMITE}):\n${culpables.join('\n')}`)
      .toEqual([])
  })

  it('los que ya pasaban no crecen', () => {
    const crecieron = Object.entries(PENDIENTES_DE_PARTIR)
      .filter(([archivo, tope]) => (tamanos.get(archivo) ?? 0) > tope)
      .map(([archivo, tope]) => `${archivo} → ${tamanos.get(archivo)} líneas (tenía ${tope})`)

    expect(crecieron, `Para tocar uno de estos, primero se parte:\n${crecieron.join('\n')}`).toEqual([])
  })

  it('el que baja del límite sale de la lista', () => {
    const yaCumplen = Object.keys(PENDIENTES_DE_PARTIR)
      .filter((archivo) => tamanos.has(archivo) && tamanos.get(archivo) <= LIMITE)
      .map((archivo) => `${archivo} → ${tamanos.get(archivo)} líneas`)

    expect(yaCumplen, `Ya cumplen: sácalos de PENDIENTES_DE_PARTIR para que no vuelvan a engordar:\n${yaCumplen.join('\n')}`)
      .toEqual([])
  })

  it('la lista no apunta a archivos que ya no existen', () => {
    // Un archivo partido o renombrado que se queda en la lista es un hueco: su
    // sucesor podría crecer sin que nadie lo mire.
    const fantasmas = [...Object.keys(PENDIENTES_DE_PARTIR), ...GENERADOS]
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
