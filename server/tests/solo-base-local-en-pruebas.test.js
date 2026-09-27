import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { esBaseLocal, exigirBaseLocalEnPruebas } = require('../dist/lib/solo-base-local-en-pruebas')
const serverDir = fileURLToPath(new URL('..', import.meta.url))

// ═══════════════════════════════════════════════════════════════════════════
// LAS PRUEBAS SOLO HABLAN CON UNA BASE LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// El 2026-09-20 cinco fallos SIMULADOS de las pruebas acabaron en el registro
// de errores de producción: Vitest lanzado desde la raíz no lee
// `vitest.config.ts`, y los clientes cargaban `server/.env` con dotenv.

describe('solo una base local bajo Vitest', () => {
  it('reconoce las bases de esta máquina, y nada más', () => {
    expect(esBaseLocal('http://127.0.0.1:54321')).toBe(true)
    expect(esBaseLocal('http://localhost:54321')).toBe(true)
    expect(esBaseLocal('http://[::1]:54321')).toBe(true)
    expect(esBaseLocal('https://abcdefgh.supabase.co')).toBe(false)
    // Un subdominio que EMPIEZA por localhost no es local.
    expect(esBaseLocal('https://localhost.ejemplo.com')).toBe(false)
    expect(esBaseLocal('')).toBe(false)
    expect(esBaseLocal(undefined)).toBe(false)
  })

  it('bajo Vitest revienta con una base remota, y dice cómo lanzarlas bien', () => {
    expect(() => exigirBaseLocalEnPruebas('https://abcdefgh.supabase.co', { VITEST: 'true' }))
      .toThrow(/solo pueden conectarse a una base LOCAL[\s\S]*npm test -w @botpanel\/server/)
    expect(() => exigirBaseLocalEnPruebas('http://127.0.0.1:54321', { VITEST: 'true' })).not.toThrow()
  })

  it('fuera de las pruebas no hace nada: producción usa su URL', () => {
    expect(() => exigirBaseLocalEnPruebas('https://abcdefgh.supabase.co', {})).not.toThrow()
  })

  // ⚠️ La regla no sirve si los clientes no la llaman. Se carga cada uno en un
  // proceso aparte, como lo haría una prueba lanzada desde la raíz, con una
  // URL remota INVENTADA: tiene que reventar antes de crear el cliente.
  it.each([
    ['el cliente de la base', 'dist/db/client.js'],
    ['el de los ajustes', 'dist/services/settings.js'],
  ])('%s se niega a nacer apuntando fuera', (_nombre, modulo) => {
    const hijo = spawnSync(process.execPath, ['-e', `require('./${modulo}')`], {
      cwd: serverDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        VITEST: 'true',
        SUPABASE_URL: 'https://proyecto-inventado.supabase.co',
        SUPABASE_SERVICE_KEY: 'clave-inventada',
      },
    })
    expect(hijo.status).not.toBe(0)
    expect(hijo.stderr).toMatch(/solo pueden conectarse a una base LOCAL/)
  })
})
