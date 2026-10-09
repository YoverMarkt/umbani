import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { parseAllDocuments } from 'yaml'

const require = createRequire(import.meta.url)

// ═══════════════════════════════════════════════════════════════════════════
// EL CONTRATO DE LAS APPS NO ENVEJECE
// ═══════════════════════════════════════════════════════════════════════════
//
// Los desarrolladores de Flutter construyen contra `docs/apps/openapi.yaml`
// sin leer el servidor. Si una ruta cambia aquí y no allí, su app falla en
// producción con todo en verde. Este guardián recorre las rutas REALES y exige
// que cada una esté en el contrato con su método.

const contrato = fs.readFileSync('../docs/apps/openapi.yaml', 'utf8')

/** { '/ruta/{param}': Set(['get', 'post']) } leído del YAML sin librerías. */
function rutasDelContrato() {
  const rutas = {}
  let actual = null
  for (const linea of contrato.split('\n')) {
    const ruta = /^ {2}(\/[^:]+):\s*$/.exec(linea)
    if (ruta) { actual = ruta[1]; rutas[actual] = new Set(); continue }
    const metodo = /^ {4}(get|post|put|patch|delete):\s*$/.exec(linea)
    if (metodo && actual) rutas[actual].add(metodo[1])
    if (/^\S/.test(linea)) actual = null
  }
  return rutas
}

/**
 * Los routers que hablan con las apps. ⚠️ Una sola lista para las dos pruebas:
 * el de entrar con correo (2026-10-06) nació fuera y sus rutas quedaban sin
 * documentar sin que nada protestara.
 */
const ROUTERS_DE_LAS_APPS = ['app-v1.routes', 'app-entrar.routes', 'app-motorizado.routes', 'storefront.routes', 'pagos.routes']

/** Las que NO usa la app, con su motivo. */
const FUERA_DEL_CONTRATO = {
  '/s/{code}': 'enlace corto de WhatsApp para la mini app web',
}

describe('docs/apps/openapi.yaml', () => {
  it('es YAML válido: lo leen las herramientas con que se hace la app Flutter', () => {
    // ⚠️ Estuvo roto sin que nada lo dijera (encontrado el 2026-10-07): dos
    // `{slug}` sin comillas dentro de un mapa en línea, y 2.210 errores en
    // cascada. Las pruebas de abajo lo leen con expresiones regulares y pasaban
    // igual; un generador de OpenAPI no habría podido ni abrirlo.
    const errores = parseAllDocuments(contrato).flatMap(d => d.errors).map(e => `línea ${e.linePos?.[0]?.line}: ${e.message}`)
    expect(errores.slice(0, 5), `openapi.yaml no es YAML válido:\n${errores.slice(0, 5).join('\n')}`).toEqual([])
  })

  it('cada ruta que usa la app está documentada con su método', () => {
    const documentadas = rutasDelContrato()
    const faltan = []
    for (const archivo of ROUTERS_DE_LAS_APPS) {
      const router = require(`../dist/routes/${archivo}`)
      for (const layer of router.stack.filter(l => l.route)) {
        const ruta = layer.route.path.replace(/:(\w+)/g, '{$1}')
        if (FUERA_DEL_CONTRATO[ruta]) continue
        for (const metodo of Object.keys(layer.route.methods)) {
          if (!documentadas[ruta]?.has(metodo)) faltan.push(`${metodo.toUpperCase()} ${ruta}`)
        }
      }
    }
    expect(faltan, `Rutas sin documentar en docs/apps/openapi.yaml:\n${faltan.join('\n')}`).toEqual([])
  })

  it('no documenta rutas que ya no existen', () => {
    const reales = new Set()
    for (const archivo of ROUTERS_DE_LAS_APPS) {
      for (const layer of require(`../dist/routes/${archivo}`).stack.filter(l => l.route)) {
        reales.add(layer.route.path.replace(/:(\w+)/g, '{$1}'))
      }
    }
    const fantasma = Object.keys(rutasDelContrato()).filter(r => !reales.has(r))
    expect(fantasma).toEqual([])
  })

  it('las guías existen y dicen la regla de oro', () => {
    for (const doc of ['README.md', 'API-UMBANI.md', 'APP-CLIENTE.md', 'APP-MOTORIZADO.md']) {
      expect(fs.existsSync(`../docs/apps/${doc}`), doc).toBe(true)
    }
    expect(fs.readFileSync('../docs/apps/README.md', 'utf8')).toMatch(/PINTA, nunca calcula/)
  })
})
