import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL CONTRATO DE LA APP WEB DE CLIENTES CON LA APP FLUTTER (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// La app web (`/u`) es la referencia de la app Flutter: si llama a una ruta
// que no está documentada, la app de tu amigo no sabría que existe. En `.mjs`
// como las demás pruebas que leen archivos: el compilador de la tienda no
// tiene los tipos de Node.

describe('el contrato con la app Flutter', () => {
  it('cada ruta de la API que usa la app web está en docs/apps/openapi.yaml', () => {
    const fuente = readFileSync(new URL('../src/umbani/api.ts', import.meta.url), 'utf8')
    const openapi = readFileSync(new URL('../../../docs/apps/openapi.yaml', import.meta.url), 'utf8')
    const rutas = [...fuente.matchAll(/['`](\/api\/v1\/[^'`?]+)/g)]
      .map(m => m[1].replace(/\$\{[^}]+\}/g, '{x}'))
    expect(rutas.length).toBeGreaterThan(5)
    for (const ruta of rutas) {
      const escapada = ruta.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{x\\\}|\{x\}/g, '\\{[^}]+\\}')
      expect(openapi, `falta ${ruta} en openapi.yaml`).toMatch(new RegExp(`^  ${escapada}:`, 'm'))
    }
  })
})
