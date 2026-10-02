import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  porcentajePorProducto, repartirParaElCliente, cotizacionParaElCliente, pedidoParaElCliente,
} = require('../dist/lib/precio-para-el-cliente')

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE VE EL CLIENTE: SUS PRECIOS, NUNCA LOS DEL LOCAL NI EL MARGEN
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-10-01): «esconderlo». Dos promesas: las líneas
// SUMAN lo que paga el cliente, y con margen por producto cada línea es la de
// la CARTA (la aritmética de `order_markup_by_line`).

const suma = lista => lista.reduce((t, v) => t + v, 0)

describe('qué regla tiene precio por producto', () => {
  it('solo `on_top` + `percentage` sin topes', () => {
    expect(porcentajePorProducto({ markupMode: 'on_top', strategy: 'percentage', percentage: 10 })).toBe(10)
    expect(porcentajePorProducto({ markupMode: 'absorbed', strategy: 'percentage', percentage: 10 })).toBeNull()
    expect(porcentajePorProducto({ markupMode: 'on_top', strategy: 'fixed', fixedAmount: 1 })).toBeNull()
    expect(porcentajePorProducto({ markupMode: 'on_top', strategy: 'percentage', percentage: 10, maxAmount: 2 })).toBeNull()
    expect(porcentajePorProducto(null)).toBeNull()
  })
})

describe('repartir lo que paga el cliente entre las líneas', () => {
  it('con margen por producto, cada línea es la de la carta (redondeo por unidad)', () => {
    // 2 × $0,75 y 1 × $3,99 con 10 %: la carta enseña $0,83 y $4,39.
    expect(repartirParaElCliente([150, 399], [2, 1], 605, 10)).toEqual([166, 439])
  })

  it('el redondeo es el de la BASE, no el de la coma flotante: $1,15 al 10 % son 12 centavos', () => {
    // `1.15 * 0.1` da 0.11499… en JavaScript; la base da 0,12. Aquí, en enteros.
    expect(repartirParaElCliente([115], [1], 127, 10)).toEqual([127])
  })

  it('si la regla cambió después del pedido, se reparte en proporción y SIGUE sumando', () => {
    const reparto = repartirParaElCliente([150, 399], [2, 1], 605, 12)
    expect(suma(reparto)).toBe(605)
    expect(reparto[0]).toBeGreaterThan(150)
    expect(reparto[1]).toBeGreaterThan(399)
  })

  it('sin porcentaje (fijo, tramos, topes): en proporción, con los centavos sueltos a los mayores restos', () => {
    const reparto = repartirParaElCliente([100, 100, 100], [1, 1, 1], 301, null)
    expect(suma(reparto)).toBe(301)
    expect(reparto).toEqual([101, 100, 100])
  })

  it('sin margen (absorbido), las líneas quedan como están', () => {
    expect(repartirParaElCliente([150, 399], [2, 1], 549, null)).toEqual([150, 399])
  })

  it('casos límite: sin líneas, o líneas a cero', () => {
    expect(repartirParaElCliente([], [], 0, 10)).toEqual([])
    expect(suma(repartirParaElCliente([0, 0], [1, 1], 50, null))).toBe(50)
  })
})

describe('la cotización que recibe el teléfono', () => {
  const cotizacion = {
    lines: [
      { productId: 'a', name: 'Agua', quantity: 2, unitPrice: 0.75, lineTotal: 1.5, options: [] },
      {
        productId: 'b', name: 'Brownie', quantity: 1, unitPrice: 3.99, lineTotal: 3.99,
        options: [{ name: 'Helado', groupName: 'Extras', quantity: 1, price: 0.5 }],
      },
    ],
    subtotal: 5.49,
    merchantSubtotal: 5.49,
    platformMarkup: 0.66,
    markupPercentage: 10,
    customerSubtotal: 6.05,
    shipping: 1.5,
    serviceFee: 0.1,
    total: 7.65,
  }
  const publica = cotizacionParaElCliente(cotizacion, 10)

  it('no lleva NADA del local ni del margen', () => {
    for (const clave of ['merchantSubtotal', 'platformMarkup', 'markupPercentage', 'customerSubtotal']) {
      expect(publica).not.toHaveProperty(clave)
    }
    // Tampoco el recargo de cada opción, que estaba en precio del local.
    expect(publica.lines[1].options[0]).not.toHaveProperty('price')
  })

  it('suma: líneas = subtotal, y subtotal + envío + tarifa = total', () => {
    expect(publica.subtotal).toBe(6.05)
    expect(Math.round(suma(publica.lines.map(l => l.lineTotal)) * 100)).toBe(605)
    expect(Math.round((publica.subtotal + publica.shipping + publica.serviceFee) * 100)).toBe(765)
  })

  it('cada precio es el de la carta', () => {
    expect(publica.lines.map(l => l.unitPrice)).toEqual([0.83, 4.39])
    expect(publica.lines.map(l => l.lineTotal)).toEqual([1.66, 4.39])
  })
})

describe('el pedido guardado, tal como lo ve su cliente', () => {
  const fila = {
    id: 'o1', order_number: 7, status: 'esperando_pago',
    total: 7.65, shipping: 1.5, service_fee: 0.1,
    merchant_subtotal: 5.49, platform_markup: 0.66, pricing_rule_id: 'r1', pricing_rule_version: 3,
    order_items: [
      { product_name: 'Agua', quantity: 2, line_total: 1.5 },
      { product_name: 'Brownie', quantity: 1, line_total: 3.99 },
    ],
  }
  const visto = pedidoParaElCliente(fila, 10)

  it('cada línea con lo que pagó ÉL: «Agua $1,66», no los $1,50 del local', () => {
    expect(visto.order_items.map(i => i.line_total)).toEqual([1.66, 4.39])
  })

  it('sin nada del local ni del margen', () => {
    for (const clave of ['merchant_subtotal', 'platform_markup', 'pricing_rule_id', 'pricing_rule_version']) {
      expect(visto).not.toHaveProperty(clave)
    }
  })

  it('suma: líneas = subtotal, y subtotal + envío + tarifa = total', () => {
    expect(visto.subtotal).toBe(6.05)
    expect(visto.service_fee).toBe(0.1)
    expect(Math.round((visto.subtotal + visto.shipping + visto.service_fee) * 100)).toBe(765)
  })

  it('un pedido nulo sigue nulo (la ruta responde 404)', () => {
    expect(pedidoParaElCliente(null, 10)).toBeNull()
  })
})
