import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildStorefrontCatalog, reglaDeMargen } = require('../dist/services/storefront')
const { quoteCart } = require('../dist/services/cotizacion')
const { enHorarioDeProducto, textoDeFranja } = require('../dist/services/schedule')

// ═══════════════════════════════════════════════════════════════════════════
// MENÚS CON RELOJ (2026-09-17)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño: «hay restaurantes que ofrecen almuerzos y otros que
// ofrecen desde el desayuno, almuerzo y meriendas». Las apps grandes no crean
// tres locales: el local es uno y su CARTA cambia con la hora.
//
// ⚠️ Cobra la base (`producto_en_horario` dentro de `create_storefront_order`,
// con los mismos casos en `tests/sql/verificar-esquema.sql`). Esto es lo que
// se PINTA y lo que se cotiza: si dijeran cosas distintas, el cliente armaría
// un carrito que el servidor rechaza al confirmar.

const LUNES_8 = new Date('2026-09-14T13:00:00Z')   // 08:00 en Ecuador
const LUNES_13 = new Date('2026-09-14T18:00:00Z')  // 13:00
const MARTES_1 = new Date('2026-09-15T06:00:00Z')  // 01:00 del martes

describe('la franja de un producto', () => {
  it('sin franja se pide siempre: es como viven todos los productos de hoy', () => {
    expect(enHorarioDeProducto({}, LUNES_8)).toBe(true)
    expect(enHorarioDeProducto({ available_days: null, available_from: null }, LUNES_13)).toBe(true)
  })

  it('el desayuno se pide a las 8 y no a la 1 de la tarde', () => {
    const desayuno = { available_from: '07:00', available_until: '11:00' }
    expect(enHorarioDeProducto(desayuno, LUNES_8)).toBe(true)
    expect(enHorarioDeProducto(desayuno, LUNES_13)).toBe(false)
  })

  it('el día también cuenta', () => {
    const soloMartes = { available_days: [2], available_from: '07:00', available_until: '11:00' }
    expect(enHorarioDeProducto(soloMartes, LUNES_8)).toBe(false)
    expect(enHorarioDeProducto({ ...soloMartes, available_days: [1, 2] }, LUNES_8)).toBe(true)
  })

  it('la carta de noche cruza la medianoche y sigue siendo del día que empezó', () => {
    const noche = { available_from: '18:00', available_until: '02:00' }
    expect(enHorarioDeProducto(noche, MARTES_1)).toBe(true)
    // A la 1 del martes manda la carta del LUNES por la noche.
    expect(enHorarioDeProducto({ ...noche, available_days: [1] }, MARTES_1)).toBe(true)
    expect(enHorarioDeProducto({ ...noche, available_days: [2] }, MARTES_1)).toBe(false)
  })

  it('el texto dice cuándo vuelve, que es lo que el cliente necesita', () => {
    expect(textoDeFranja({ available_from: '07:00', available_until: '11:00' }))
      .toBe('Se pide de 07:00 a 11:00')
    expect(textoDeFranja({ available_days: [1, 2, 3, 4, 5], available_from: '07:00', available_until: '11:00' }))
      .toBe('Se pide de lunes a viernes, de 07:00 a 11:00')
    expect(textoDeFranja({ available_days: [0, 6] }))
      .toBe('Se pide sábado y domingo')
    expect(textoDeFranja({})).toBe(null)
  })
})

describe('la tienda pinta la carta de esta hora', () => {
  const entrada = (extra) => ({
    categories: [{ id: 'cat-1', name: 'Carta', sort: 1 }],
    products: [
      { id: 'des', name: 'Desayuno completo', price: '3.50', category_id: 'cat-1', stock: 'disponible',
        available_from: '07:00', available_until: '11:00' },
      { id: 'alm', name: 'Almuerzo del día', price: '3.85', category_id: 'cat-1', stock: 'disponible' },
    ],
    variants: [], extras: [], ...extra,
  })

  it('fuera de su franja el producto NO se puede pedir, y se dice por qué', () => {
    const catalogo = buildStorefrontCatalog(entrada(), { now: LUNES_13 })
    const desayuno = catalogo.products.find(p => p.id === 'des')
    expect(desayuno.available).toBe(false)
    expect(desayuno.availableHint).toBe('Se pide de 07:00 a 11:00')
    // El que no tiene franja sigue igual que siempre.
    expect(catalogo.products.find(p => p.id === 'alm').available).toBe(true)
  })

  it('en su franja se pide con normalidad', () => {
    const catalogo = buildStorefrontCatalog(entrada(), { now: LUNES_8 })
    const desayuno = catalogo.products.find(p => p.id === 'des')
    expect(desayuno.available).toBe(true)
    // La franja se sigue diciendo: el cliente sabe hasta cuándo puede pedirlo.
    expect(desayuno.availableHint).toBe('Se pide de 07:00 a 11:00')
  })
})

describe('la cotización no cotiza lo que no se puede pedir', () => {
  const REGLA = reglaDeMargen({ strategy: 'percentage', percentage: 10, mode: 'on_top', version: 1 })
  const cotizar = (now) => quoteCart({
    items: [{ productId: 'des', quantity: 1 }],
    products: [{
      id: 'des', name: 'Desayuno completo', price: '3.50', active: true, stock: 'disponible',
      available_from: '07:00', available_until: '11:00',
    }],
    variants: [], optionGroups: [], options: [],
    deliveryFee: 0, fulfillment: 'pickup', pricing: REGLA, now,
  })

  it('a la 1 de la tarde el desayuno se rechaza, como un agotado', () => {
    expect(cotizar(LUNES_13).error).toContain('no se puede pedir a esta hora')
  })

  it('y a las 8 de la mañana cotiza', () => {
    expect(cotizar(LUNES_8).error).toBeUndefined()
  })
})
