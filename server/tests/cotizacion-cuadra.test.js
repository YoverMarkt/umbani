import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { quoteCart } = require('../dist/services/cotizacion')
const { reglaDeMargen } = require('../dist/services/storefront')

// ═══════════════════════════════════════════════════════════════════════════
// LA COTIZACIÓN COBRA LO MISMO QUE EL PEDIDO
// ═══════════════════════════════════════════════════════════════════════════
//
// Medido en producción el 2026-09-13 con 3 × $0.75:
//
//   catálogo enseña   $0.83 × 3 = $2.49
//   la cotización      $2.48        ← la única que discrepaba
//   el pedido cobra    $2.49
//
// La base aplica el margen POR LÍNEA cuando el modo es `on_top` con
// `percentage` (`order_markup_by_line`), y su comentario dice por qué: el
// cliente ve un precio POR PRODUCTO, así que el total tiene que ser lo que él
// sumaría. `quoteCart` se había quedado con la regla anterior —«un solo
// redondeo sobre el subtotal, nunca por línea»— que era justo la contraria.
//
// ⚠️ Esto importa más de lo que parecen dos centavos: el endpoint de
// cotización es lo que usaría una pasarela de pago para decir cuánto cobrar.

const REGLA = reglaDeMargen({ strategy: 'percentage', percentage: 10, mode: 'on_top', version: 1 })

const producto = (precio) => ({
  id: 'p1', name: 'Cola Mediana', price: precio, active: true, stock: 'disponible',
})

const cotizar = (precio, cantidad, pricing = REGLA) => quoteCart({
  items: [{ productId: 'p1', quantity: cantidad }],
  products: [producto(precio)],
  variants: [], optionGroups: [], options: [],
  deliveryFee: 0, fulfillment: 'pickup', pricing,
})

/**
 * La MISMA aritmética que `order_markup_by_line`, en centavos enteros.
 *
 * ⚠️ En flotante esto NO reproduce a la base: `1.15 * 0.1` da
 * `0.11499999999999999` y redondea a 11 centavos, mientras PostgreSQL —que
 * calcula en decimal exacto— da 12. Escrito en enteros, `115 × 10 / 100` es
 * exactamente `11.5` y redondea igual que la base.
 */
const comoCobraLaBase = (precio, cantidad, pct = 10) => {
  const unitario = Math.round(precio * 100)
  const margenUnitario = Math.round((unitario * pct) / 100)
  return ((unitario + margenUnitario) * cantidad) / 100
}

describe('la cotización usa la aritmética que cobra la base', () => {
  it('el caso medido en producción: 3 × $0.75', () => {
    expect(cotizar(0.75, 3).total).toBe(2.49)
  })

  it('barrido de precios y cantidades: nunca discrepa', () => {
    // ⚠️ Un barrido y no tres casos: los descuadres de redondeo aparecen en
    // combinaciones concretas —0.75, 0.05, 1.15— y elegirlas a mano es elegir
    // las que ya sabes que fallan.
    const fallos = []
    for (const precio of [0.05, 0.15, 0.35, 0.60, 0.75, 0.85, 0.95, 1.00, 1.15, 1.50, 2.75, 3.50, 7.35, 19.99]) {
      for (const cantidad of [1, 2, 3, 4, 5, 7, 9, 11, 20]) {
        const q = cotizar(precio, cantidad).total
        const base = comoCobraLaBase(precio, cantidad)
        if (Math.abs(q - base) >= 0.005) fallos.push(`${cantidad} × $${precio}: cotiza ${q}, cobra ${base}`)
      }
    }
    expect(fallos, fallos.slice(0, 6).join(' | ')).toEqual([])
  })

  it('las líneas SUMAN el total, siempre', () => {
    // Es la propiedad que el cliente comprueba de un vistazo. Si no se cumple,
    // da igual quién tenga razón: el carrito se lee como un error.
    for (const [precio, cantidad] of [[0.75, 3], [0.05, 7], [1.15, 9], [3.50, 4]]) {
      const q = cotizar(precio, cantidad)
      const cent = Math.round(precio * 100)
      const unitarioConMargen = cent + Math.round((cent * 10) / 100)
      expect((unitarioConMargen * cantidad) / 100, `${cantidad} × $${precio}`).toBe(q.total)
    }
  })

  it('sin regla de margen, el total es el precio del comercio', () => {
    expect(cotizar(0.75, 3, null).total).toBe(2.25)
  })

  it('con `absorbed` el cliente NO paga margen de más', () => {
    // El margen se le quita al dueño, no se le suma al cliente: el total es el
    // precio de catálogo y lo que cambia es lo que recibe el local.
    const absorbida = reglaDeMargen({ strategy: 'percentage', percentage: 10, mode: 'absorbed', version: 1 })
    const q = cotizar(0.75, 3, absorbida)
    expect(q.total).toBe(2.25)
    expect(q.merchantSubtotal).toBeLessThan(2.25)
  })
})

describe('la aritmética en centavos es la de PostgreSQL', () => {
  // ⚠️ Comparar la cotización contra MI réplica de la base no prueba nada: si
  // la réplica está mal, las dos coinciden y las dos se equivocan.
  //
  // Estos valores salen de ejecutar en el PostgreSQL de producción la MISMA
  // expresión que `order_markup_by_line` —`round(precio * (10/100.0), 2)`—
  // el 2026-09-13. Son la verdad contra la que se compara el cálculo en JS.
  //
  // Los tres primeros son los que delataban la coma flotante: `1.15 * 0.1` en
  // JavaScript da 0.11499999999999999 y redondea a 0.11; PostgreSQL da 0.12.
  const MARGEN_SEGUN_POSTGRES = [
    [0.35, 0.04], [1.15, 0.12], [0.75, 0.08],
    [0.05, 0.01], [0.15, 0.02], [0.60, 0.06], [0.85, 0.09],
    [0.95, 0.10], [1.00, 0.10], [1.50, 0.15], [2.75, 0.28],
    [3.50, 0.35], [7.35, 0.74], [19.99, 2.00],
  ]

  it('el margen por unidad coincide al centavo', () => {
    for (const [precio, esperado] of MARGEN_SEGUN_POSTGRES) {
      const q = cotizar(precio, 1)
      expect(Math.round((q.total - precio) * 100) / 100, `$${precio}`).toBe(esperado)
    }
  })

  it('y multiplicado por la cantidad, también', () => {
    for (const [precio, margen] of MARGEN_SEGUN_POSTGRES) {
      for (const cantidad of [3, 7, 12]) {
        const esperado = Math.round((precio + margen) * 100) * cantidad / 100
        expect(cotizar(precio, cantidad).total, `${cantidad} × $${precio}`).toBe(esperado)
      }
    }
  })
})
