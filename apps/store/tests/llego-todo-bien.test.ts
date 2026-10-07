import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ConfirmacionDelPedido, TrackedOrder } from '../src/lib/types'

// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» EN «MIS PEDIDOS» (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//   1. Solo se ofrece cuando el servidor dice que se puede (entregado, sin
//      reclamo, dentro de las 48 h): la app no decide plazos.
//   2. Lo que pasó después se dice con palabras, y la cifra es la que DECIDIÓ
//      Umbani al revisarlo, nunca una que calcule el teléfono.
//   3. Lo que se manda: el tipo, las líneas con su id y cantidad, y la nota.

const pedido = (confirmacion: ConfirmacionDelPedido | null): TrackedOrder => ({
  id: 'p1', order_number: 41, status: 'completado', total: 12.5, fulfillment: 'delivery', created_at: '2026-10-06T12:00:00Z',
  order_items: [{ id: 'l1', product_name: 'Pizza', quantity: 2, line_total: 8.8 }], events: [], confirmacion,
})
const pintar = async (confirmacion: ConfirmacionDelPedido | null) => {
  const { LlegoTodoBien } = await import('../src/components/LlegoTodoBien')
  return renderToStaticMarkup(createElement(LlegoTodoBien, { slug: 'demo', pedido: pedido(confirmacion), onCambio: () => {} }))
}

describe('qué se le enseña', () => {
  it('dentro del plazo: la pregunta y sus dos botones', async () => {
    const html = await pintar({ todoBien: false, reclamo: null, reclamableHasta: '2026-10-08T12:00:00Z' })
    expect(html).toContain('¿Llegó todo bien?')
    expect(html).toContain('Sí, todo bien')
    expect(html).toContain('Algo salió mal')
  })

  it('fuera del plazo (o sin entregar), nada: el plazo lo decide el servidor', async () => {
    expect(await pintar({ todoBien: false, reclamo: null, reclamableHasta: null })).toBe('')
    expect(await pintar(null)).toBe('')
  })

  it('después: lo que pasó, con palabras; y la cifra la que decidió Umbani', async () => {
    expect(await pintar({ todoBien: true, reclamo: null, reclamableHasta: null })).toContain('Nos dijiste que llegó todo bien')
    expect(await pintar({ todoBien: false, reclamableHasta: null, reclamo: { tipo: 'falta_producto', estado: 'abierta', sugeridoCents: 440, compensacionCents: null } }))
      .toContain('lo estamos revisando')
    const resuelta = await pintar({ todoBien: false, reclamableHasta: null, reclamo: { tipo: 'falta_producto', estado: 'resuelta', sugeridoCents: 440, compensacionCents: 300 } })
    expect(resuelta).toContain('Umbani te compensa $3.00')
    expect(resuelta).not.toContain('4.40')
  })
})

describe('qué se manda', () => {
  beforeEach(() => {
    vi.resetModules()
    const almacen = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => almacen.set(k, v), removeItem: (k: string) => almacen.delete(k) })
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    vi.stubGlobal('window', { location: { pathname: '/t/demo', search: '' }, history: { replaceState: () => {} } })
  })

  it('«todo bien» y el reclamo van a su ruta, con el tipo, las líneas y la nota', async () => {
    const fetchFalso = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true, sugeridoCents: 440 }) })
    vi.stubGlobal('fetch', fetchFalso)
    const { confirmarTodoBien, reportarProblema } = await import('../src/lib/reclamos')
    await confirmarTodoBien('demo', 'p1')
    expect(fetchFalso.mock.calls[0][0]).toBe('/api/store/demo/orders/p1/todo-bien')
    expect(fetchFalso.mock.calls[0][1].method).toBe('POST')
    await reportarProblema('demo', 'p1', { tipo: 'falta_producto', lineas: [{ item: 'l1', cantidad: 1 }], nota: 'Faltó una' })
    expect(fetchFalso.mock.calls[1][0]).toBe('/api/store/demo/orders/p1/reclamo')
    expect(JSON.parse(fetchFalso.mock.calls[1][1].body)).toEqual({ tipo: 'falta_producto', lineas: [{ item: 'l1', cantidad: 1 }], nota: 'Faltó una' })
  })
})
