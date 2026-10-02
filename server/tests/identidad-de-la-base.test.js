import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { comprobarIdentidadDeLaBase, MARCA_DE_STAGING } = require('../dist/config/identidad-de-la-base')
const { esStaging } = require('../dist/config/environment')
const { avisoDeEntorno } = require('../dist/lib/franja-entorno')
const { leerConfiguracionPayphone } = require('../dist/config/payphone')

// ═══════════════════════════════════════════════════════════════════════════
// EL CANDADO DE LA BASE: STAGING Y PRODUCCIÓN NO SE CRUZAN NUNCA
// ═══════════════════════════════════════════════════════════════════════════
//
// Con un staging en internet, una sola variable mal copiada pondría a un
// staging a procesar los pedidos de los clientes de verdad, o a producción a
// servir locales inventados. El servidor le pregunta a su BASE quién es antes
// de abrir el puerto.

const marca = valor => async () => valor
const caida = async () => { throw new Error('connect ETIMEDOUT') }

describe('el candado de la base', () => {
  it('staging contra una base marcada de staging: arranca', async () => {
    expect(await comprobarIdentidadDeLaBase({ staging: true, leerMarca: marca(MARCA_DE_STAGING) })).toEqual({ ok: true })
  })

  it('producción contra una base sin marca (la de producción): arranca', async () => {
    expect(await comprobarIdentidadDeLaBase({ staging: false, leerMarca: marca(null) })).toEqual({ ok: true })
  })

  it('⚠️ STAGING contra una base SIN marca —podría ser producción—: NO arranca', async () => {
    const r = await comprobarIdentidadDeLaBase({ staging: true, leerMarca: marca(null) })
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/PRODUCCIÓN/)
  })

  it('⚠️ PRODUCCIÓN contra una base de STAGING: NO arranca', async () => {
    const r = await comprobarIdentidadDeLaBase({ staging: false, leerMarca: marca('staging') })
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/datos de mentira/)
  })

  it('una marca con mayúsculas o espacios se lee igual', async () => {
    expect((await comprobarIdentidadDeLaBase({ staging: true, leerMarca: marca(' Staging ') })).ok).toBe(true)
  })

  it('asimétrico a propósito: si la base no responde, el STAGING no arranca…', async () => {
    const r = await comprobarIdentidadDeLaBase({ staging: true, leerMarca: caida })
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/ETIMEDOUT/)
  })

  it('…y PRODUCCIÓN sí: un tropiezo de la red al desplegar no puede tumbarla', async () => {
    expect(await comprobarIdentidadDeLaBase({ staging: false, leerMarca: caida })).toEqual({ ok: true })
  })
})

describe('qué es un staging', () => {
  it('lo dice UMBANI_ENTORNO, sin distinguir mayúsculas', () => {
    expect(esStaging({ UMBANI_ENTORNO: 'staging' })).toBe(true)
    expect(esStaging({ UMBANI_ENTORNO: ' STAGING ' })).toBe(true)
    expect(esStaging({})).toBe(false)
    expect(esStaging({ UMBANI_ENTORNO: 'produccion' })).toBe(false)
  })

  it('el staging en INTERNET (Railway) también pinta su franja, aunque para lo demás sea un despliegue', () => {
    const enRailway = {
      UMBANI_ENTORNO: 'staging',
      RAILWAY_ENVIRONMENT: 'staging',
      BASE_URL: 'https://web-staging.up.railway.app',
      SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
    }
    expect(avisoDeEntorno(enRailway)?.texto).toMatch(/STAGING/)
  })

  it('producción sigue sin franja', () => {
    expect(avisoDeEntorno({
      RAILWAY_ENVIRONMENT: 'production',
      BASE_URL: 'https://web-production.up.railway.app',
      SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
    })).toBeNull()
  })

  it('⚠️ un staging NUNCA cobra de verdad: con modo «produccion» se queda sin tarjeta', () => {
    const variables = { PAYPHONE_TOKEN: 't', PAYPHONE_MODO: 'produccion' }
    expect(leerConfiguracionPayphone(variables)?.modo).toBe('produccion')
    expect(leerConfiguracionPayphone({ ...variables, UMBANI_ENTORNO: 'staging' })).toBeNull()
    expect(leerConfiguracionPayphone({ PAYPHONE_TOKEN: 't', PAYPHONE_MODO: 'pruebas', UMBANI_ENTORNO: 'staging' })?.modo).toBe('pruebas')
  })
})

describe('el candado está enchufado ANTES de abrir el puerto', () => {
  // De nada sirve un candado bien probado que el arranque no consulte, o que
  // consulte DESPUÉS de arrancar las tareas de fondo.
  const arranque = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('el puerto se abre dentro del `then` del candado, y solo si dijo que sí', () => {
    const candado = arranque.indexOf('void comprobarIdentidadDeLaBase({')
    const salida = arranque.indexOf('process.exit(1)', candado)
    const puerto = arranque.indexOf('httpServer = app.listen(port, alAbrirElPuerto)')
    expect(candado).toBeGreaterThan(0)
    expect(salida).toBeGreaterThan(candado)
    expect(puerto).toBeGreaterThan(salida)
    // Y no hay otro `app.listen` que se lo salte.
    expect(arranque.match(/app\.listen\(/g)).toHaveLength(1)
  })

  it('las tareas de fondo viven dentro de lo que corre al abrir el puerto', () => {
    const alAbrir = arranque.indexOf('const alAbrirElPuerto = (): void => {')
    const tareas = arranque.indexOf('if (tareas.permitido) {')
    const candado = arranque.indexOf('void comprobarIdentidadDeLaBase({')
    expect(alAbrir).toBeGreaterThan(0)
    expect(tareas).toBeGreaterThan(alAbrir)
    expect(tareas).toBeLessThan(candado)
  })
})
