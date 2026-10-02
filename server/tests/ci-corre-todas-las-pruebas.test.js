import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const raiz = fileURLToPath(new URL('../..', import.meta.url))
const ci = readFileSync(`${raiz}/.github/workflows/ci.yml`, 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// TODO WORKSPACE CON PRUEBAS TIENE QUE CORRERLAS EN EL CI
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Nace de un fallo del 2026-09-14, y de la familia más cara de este
// proyecto. Se montaron pruebas en los dos paneles, `npm run check` las corría
// en local… y el CI NO: tiene su propia lista de comandos por trabajo, y nadie
// la tocó. El PR salió con los seis checks en VERDE precisamente porque el CI
// no las miraba.
//
// Una red que solo existe en el portátil de quien la escribió no es una red.
// Esta prueba lee el CI y exige que cada workspace con script `test` aparezca
// ejecutado ahí.

describe('el CI corre las pruebas de cada workspace', () => {
  const workspaces = ['server', ...readdirSync(`${raiz}/apps`).map(a => `apps/${a}`)]
    .filter(ruta => existsSync(`${raiz}/${ruta}/package.json`))
    .map((ruta) => {
      const pkg = JSON.parse(readFileSync(`${raiz}/${ruta}/package.json`, 'utf8'))
      return { ruta, nombre: pkg.name, tieneTests: Boolean(pkg.scripts?.test) }
    })
    .filter(w => w.tieneTests)

  it('hay workspaces con pruebas que vigilar', () => {
    expect(workspaces.length).toBeGreaterThanOrEqual(4)
  })

  for (const { nombre } of [
    { nombre: '@botpanel/server' }, { nombre: '@botpanel/store' },
    { nombre: '@botpanel/client' }, { nombre: '@botpanel/admin' },
  ]) {
    it(`${nombre} corre sus pruebas en el CI`, () => {
      const lasCorre = new RegExp(`npm (?:test|run test:coverage) -w ${nombre.replace('/', '\\/')}`).test(ci)
      expect(lasCorre, `${nombre} tiene script \`test\` y el CI no lo ejecuta`).toBe(true)
    })
  }

  // Los recorridos de punta a punta van APARTE de `npm test` (necesitan
  // Docker): la regla de arriba no los ve, y es justo la familia de fallo que
  // esta prueba existe para impedir — una red que solo corre en el portátil.
  it('el CI corre los recorridos de punta a punta (servidor + Supabase)', () => {
    expect(ci, 'el CI no corre `npm run test:recorridos -w @botpanel/server`')
      .toMatch(/npm run test:recorridos -w @botpanel\/server/)
    const pkg = JSON.parse(readFileSync(`${raiz}/server/package.json`, 'utf8'))
    expect(pkg.scripts['test:recorridos']).toContain('vitest.recorridos.config.mjs')
  })

  it('ningún workspace con pruebas se queda fuera, aunque sea nuevo', () => {
    // Lo que de verdad protege: un panel nuevo con pruebas que nadie añada al
    // CI hace fallar ESTA prueba, en vez de pasar en verde sin mirarlas.
    const olvidados = workspaces
      .filter(w => !new RegExp(`npm (?:test|run test:coverage) -w ${w.nombre.replace('/', '\\/')}`).test(ci))
      .map(w => w.nombre)
    expect(olvidados, `el CI no corre: ${olvidados.join(', ')}`).toEqual([])
  })
})
