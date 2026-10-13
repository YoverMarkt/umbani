import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL CONTRATO DE LAS APPS WEB CON LAS APPS FLUTTER (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Las apps web (`/u` clientes, `/r` repartidores) son la referencia de las
// apps Flutter: si llaman a una ruta que no está documentada, quien hace la
// app Flutter no sabría que existe. En `.mjs` como las demás pruebas que leen
// archivos: el compilador de la tienda no tiene los tipos de Node.

const openapi = readFileSync(new URL('../../../docs/apps/openapi.yaml', import.meta.url), 'utf8')

/** Las rutas `/api/v1/…` que llama un archivo, con cada `${…}` como parámetro. */
const rutasDe = archivo => [...readFileSync(new URL(archivo, import.meta.url), 'utf8').matchAll(/['`](\/api\/v1\/[^'`?]+)/g)]
  .map(m => m[1].replace(/\$\{[^}]+\}/g, '{x}'))

const documentada = ruta => {
  const escapada = ruta.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\\{x\\\}|\{x\}/g, '\\{[^}]+\\}')
  return new RegExp(`^  ${escapada}:`, 'm')
}

describe('el contrato con las apps Flutter', () => {
  it('cada ruta que usa la app de clientes está en docs/apps/openapi.yaml', () => {
    const rutas = rutasDe('../src/umbani/api.ts')
    expect(rutas.length).toBeGreaterThan(5)
    for (const ruta of rutas) expect(openapi, `falta ${ruta} en openapi.yaml`).toMatch(documentada(ruta))
  })

  it('cada ruta que usa la app de repartidores está en docs/apps/openapi.yaml', () => {
    const rutas = rutasDe('../src/repartidor/api.ts')
    // Las nueve de la guía del motorizado (2026-10-12: + «Llegué» y «No estaba
    // el cliente»): si alguna se arma por partes, la prueba dejaría de verla —
    // por eso se cuentan.
    expect(rutas).toHaveLength(9)
    for (const ruta of rutas) expect(openapi, `falta ${ruta} en openapi.yaml`).toMatch(documentada(ruta))
  })

  it('sabe cazar una ruta que no está documentada', () => {
    expect(openapi).not.toMatch(documentada('/api/v1/motorizado/pedidos/{x}/inventada'))
  })
})

// ── El cobro en la puerta (2026-10-10) ────────────────────────────────────
// Desde que el cliente puede pagar una parte con su saldo Umbani, el total del
// pedido y lo que el repartidor cobra ya no son lo mismo. La app tiene que
// decir y confirmar `cobrarCents` (lo calcula el servidor), nunca el total.
describe('el repartidor cobra lo que falta, no el total', () => {
  const fuente = readFileSync(new URL('../src/repartidor/RepartidorApp.tsx', import.meta.url), 'utf8')

  it('«Cobras $X», «¿Cobraste $X?» y «Sí, cobré $X» llevan `cobrarCents`', () => {
    expect(fuente).toContain('pedido.cobrarCents ?? pedido.totalCents')
    expect(fuente.match(/dolares\(aCobrar\(pedido\)\)/g)).toHaveLength(3)
    expect(fuente).not.toMatch(/dolares\(pedido\.totalCents\)/)
  })

  it('el contrato lo documenta', () => {
    expect(openapi).toMatch(/cobrarCents \(2026-10-10\) es lo que COBRA en la puerta/)
  })
})
