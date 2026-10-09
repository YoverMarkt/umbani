import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COSTE_DE_LAS_CLAVES, claveCorrecta } from '../dist/lib/clave-sin-pistas.js'

const require = createRequire(import.meta.url)
const bcrypt = require('bcryptjs')
const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

// ═══════════════════════════════════════════════════════════════════════════
// UNA CLAVE SE COMPRUEBA IGUAL EXISTA O NO LA CUENTA (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Con un correo sin cuenta el login respondía al momento, y con uno que sí la
// tiene pagaba un bcrypt: cronometrando se sabía quién tiene cuenta. Ver
// `src/lib/clave-sin-pistas.ts`.

afterEach(() => vi.restoreAllMocks())

describe('claveCorrecta', () => {
  it('la clave de la cuenta entra; otra no', async () => {
    const hash = await bcrypt.hash('la-clave-correcta', 4)
    expect(await claveCorrecta('la-clave-correcta', hash)).toBe(true)
    expect(await claveCorrecta('otra-clave', hash)).toBe(false)
  })

  it('sin cuenta o sin hash TAMBIÉN paga un bcrypt, y siempre dice que no', async () => {
    const compare = vi.spyOn(bcrypt, 'compare')
    for (const hash of [null, undefined, '']) {
      expect(await claveCorrecta('cualquiera', hash)).toBe(false)
    }
    expect(compare).toHaveBeenCalledTimes(3)
    // Y contra un hash del MISMO coste que las claves guardadas: si costara
    // menos, la diferencia de tiempo volvería a delatar la cuenta.
    const coste = String(COSTE_DE_LAS_CLAVES).padStart(2, '0')
    expect(compare.mock.calls[0][1]).toMatch(new RegExp(`^\\$2[aby]\\$${coste}\\$`))
  })

  it('ni la clave vacía entra en una cuenta sin hash', async () => {
    expect(await claveCorrecta('', null)).toBe(false)
  })
})

describe('guardián: todas las claves del servidor pasan por aquí', () => {
  const archivos = (dir) => readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivos(ruta)
    return ruta.endsWith('.ts') ? [ruta] : []
  })
  const fuentes = archivos(src).map(ruta => [path.relative(src, ruta), readFileSync(ruta, 'utf8')])

  it('ninguna ruta compara claves por su cuenta', () => {
    // Un `bcrypt.compare` suelto es un login que vuelve a contestar antes
    // cuando la cuenta no existe.
    const sueltos = fuentes
      .filter(([ruta, texto]) => ruta !== path.join('lib', 'clave-sin-pistas.ts') && /bcrypt\.compare\(/.test(texto))
      .map(([ruta]) => ruta)
    expect(sueltos).toEqual([])
  })

  it('el relleno tiene el coste con el que se GUARDAN las claves', () => {
    const costes = fuentes.flatMap(([ruta, texto]) => (
      [...texto.matchAll(/bcrypt\.hash\([^,]+,\s*(\d+)\)/g)].map(m => `${ruta}: coste ${m[1]}`)
    ))
    // Si no encontrara ninguno, este guardián no vigilaría nada.
    expect(costes.length).toBeGreaterThan(3)
    expect(costes.filter(c => !c.endsWith(`coste ${COSTE_DE_LAS_CLAVES}`))).toEqual([])
  })
})
