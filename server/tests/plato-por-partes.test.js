import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildMealLines } = require('../dist/services/pricing')
const { quoteCart } = require('../dist/services/cotizacion')

// ═══════════════════════════════════════════════════════════════════════════
// EL PLATO POR PARTES — el almuerzo de una familia
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño de una almuercería pone UN precio al almuerzo completo y un precio
// suelto a cada parte. La familia marca cuántas sopas y cuántos segundos
// quiere, y el sistema arma los almuerzos:
//
//   · una porción de CADA parte es un almuerzo completo, al precio del dueño;
//   · lo que sobra de una parte se cobra a su precio suelto;
//   · un adicional con precio va en su propia línea;
//   · lo gratis dice «Gratis», va con el plato y no suma.
//
// ⚠️ Los MISMOS casos que `verificar-esquema.sql` ejecuta contra PostgreSQL:
// este motor pinta y cotiza, la base cobra, y si divergen el cliente lee un
// número y paga otro.

const SOPA = { id: 'g-sopa', name: 'Sopa', sort: 0, isMealPart: true, loosePrice: 1.5 }
const SEGUNDO = { id: 'g-segundo', name: 'Segundo', sort: 1, isMealPart: true, loosePrice: 2.5 }
const ACOMPANAR = { id: 'g-acompanar', name: 'Para acompañar', sort: 2, isMealPart: false, loosePrice: null }

const elegir = (grupo, optionId, name, quantity, { price = 0, sort = 0 } = {}) => ({
  optionId, groupId: grupo.id, name, sort, quantity, price,
})

const CALDO = n => elegir(SOPA, 'o-caldo', 'Caldo de res', n)
const CREMA = n => elegir(SOPA, 'o-crema', 'Crema de zapallo', n, { sort: 1 })
const POLLO = n => elegir(SEGUNDO, 'o-pollo', 'Pollo', n)
const CEVICHE = n => elegir(SEGUNDO, 'o-ceviche', 'Ceviche', n, { sort: 1 })
const JUGO = n => elegir(ACOMPANAR, 'o-jugo', 'Jugo', n)
const CARNE = n => elegir(ACOMPANAR, 'o-carne', 'Porción de carne', n, { price: 0.5, sort: 1 })

const armar = (choices, { price = 3, groups = [SOPA, SEGUNDO, ACOMPANAR] } = {}) => buildMealLines({
  productName: 'Almuerzo del día',
  price,
  groups,
  choices,
})

const opcion = (choice, quantity = choice.quantity) => ({
  optionId: choice.optionId, groupId: choice.groupId, name: choice.name, quantity,
})

describe('la base del plato: las partes forman almuerzos', () => {
  it('la familia: 2 almuerzos, un segundo suelto y la carne aparte', () => {
    const r = armar([CEVICHE(1), CALDO(2), POLLO(2), JUGO(3), CARNE(1)])

    expect(r.error).toBeUndefined()
    expect(r.lines).toEqual([
      {
        name: 'Almuerzo del día',
        quantity: 2,
        unitPrice: 3,
        options: [opcion(CALDO(2)), opcion(POLLO(2)), opcion(JUGO(3))],
      },
      { name: 'Solo segundo', quantity: 1, unitPrice: 2.5, options: [opcion(CEVICHE(1))] },
      { name: 'Porción de carne', quantity: 1, unitPrice: 0.5, options: [] },
    ])
  })

  it('el almuerzo vale lo que pone el dueño, aunque las partes sueltas sumen menos', () => {
    const baratas = [
      { ...SOPA, loosePrice: 0.5 },
      { ...SEGUNDO, loosePrice: 0.5 },
    ]
    const r = armar([CALDO(1), POLLO(1)], { price: 5, groups: baratas })
    expect(r.lines).toEqual([
      { name: 'Almuerzo del día', quantity: 1, unitPrice: 5, options: [opcion(CALDO(1)), opcion(POLLO(1))] },
    ])
  })

  it('cinco sopas y cuatro segundos: cuatro almuerzos y una sopa sola', () => {
    const r = armar([CALDO(5), POLLO(4)])
    expect(r.lines.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([
      ['Almuerzo del día', 4, 3],
      ['Solo sopa', 1, 1.5],
    ])
  })

  it('las porciones sueltas salen de las ÚLTIMAS opciones del dueño', () => {
    // 1 caldo + 2 cremas con 2 segundos: el almuerzo se lleva el caldo y una
    // crema, y la crema que sobra es la sopa sola.
    const r = armar([CREMA(2), CALDO(1), POLLO(2)])
    expect(r.lines[0].options).toEqual([opcion(CALDO(1)), opcion(CREMA(2), 1), opcion(POLLO(2))])
    expect(r.lines[1]).toEqual({
      name: 'Solo sopa', quantity: 1, unitPrice: 1.5, options: [opcion(CREMA(2), 1)],
    })
  })

  it('el mismo pedido marcado en otro orden cuesta y se arma igual', () => {
    const uno = armar([CALDO(2), POLLO(2), CEVICHE(1), JUGO(3), CARNE(1)])
    const otro = armar([CARNE(1), JUGO(3), CEVICHE(1), POLLO(2), CALDO(2)])
    expect(otro).toEqual(uno)
  })
})

describe('lo que sobra y lo gratis', () => {
  it('solo una sopa: se cobra suelta y lo gratis la acompaña', () => {
    const r = armar([CALDO(1), JUGO(1)])
    expect(r.lines).toEqual([
      { name: 'Solo sopa', quantity: 1, unitPrice: 1.5, options: [opcion(CALDO(1)), opcion(JUGO(1))] },
    ])
  })

  it('lo gratis no suma al precio del plato', () => {
    const r = armar([CALDO(1), POLLO(1), JUGO(1)])
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].unitPrice).toBe(3)
  })

  // ⚠️ ESTA PRUEBA EXIGÍA LO CONTRARIO HASTA EL 2026-09-16, y con estos mismos
  // datos: `[CALDO(1), POLLO(1), JUGO(5)]` se daba por bueno y se llamaba «lo
  // gratis no suma aunque se pidan muchos: lo decide el dueño».
  //
  // No lo decidía el dueño: no lo decidía nadie. Lo vio él probando su local —
  // «el jugo gratis es por el número de almuerzos que lleva el cliente, pero
  // ahora pueden elegir muchos jugos». El único tope era `maxSelectable`, que
  // en su carta valía 100: un almuerzo de $3.50 con cien jugos.
  it('pero va UNO POR PLATO: cinco jugos sobre un plato se rechazan', () => {
    const r = armar([CALDO(1), POLLO(1), JUGO(5)])
    expect(r.lines).toBeUndefined()
    expect(r.error).toContain('va con cada plato')
    expect(r.error).toContain('llevas 1')
  })

  it('«2 almuerzos y un segundo» son TRES platos y caben tres jugos', () => {
    // El ejemplo literal del dueño: 2 completos + 1 suelto.
    const r = armar([CALDO(2), POLLO(3), JUGO(3)])
    expect(r.error).toBeUndefined()
  })

  it('lo que se COBRA no tiene tope: es lo gratis lo que se protege', () => {
    const r = armar([CALDO(1), POLLO(1), CARNE(5)])
    expect(r.error).toBeUndefined()
    expect(r.lines.find(l => l.name === 'Porción de carne').quantity).toBe(5)
  })

  it('sin precio suelto, la parte que sobra NO se vende', () => {
    const r = armar([CALDO(2), POLLO(1)], { groups: [{ ...SOPA, loosePrice: null }, SEGUNDO] })
    expect(r.error).toBe('En Almuerzo del día no se vende sopa por separado: completa el plato')
  })

  it('solo lo gratis no es un plato', () => {
    expect(armar([JUGO(2)]).error).toBe('Elige qué quieres en Almuerzo del día')
  })

  it('un adicional no puede restar precio', () => {
    const resta = elegir(ACOMPANAR, 'o-resta', 'Sin arroz', 1, { price: -0.25 })
    expect(armar([CALDO(1), POLLO(1), resta]).error)
      .toBe('Sin arroz tiene un precio no válido en Almuerzo del día')
  })

  it('más de 99 almuerzos en una mesa no es un pedido', () => {
    expect(armar([CALDO(100), POLLO(100)]).error).toBe('La cantidad debe estar entre 1 y 99')
  })
})

// ── La cotización: el mismo motor, con el catálogo del servidor ────────────

const ALMUERZO = {
  id: 'alm', name: 'Almuerzo del día', price: 3, price_sale: null,
  stock: 'disponible', category_id: null,
}

const grupoDelCatalogo = (grupo, extra = {}) => ({
  id: grupo.id, product_id: 'alm', category_id: null, name: grupo.name,
  selection_type: 'quantity', required: false, min_selectable: 0, max_selectable: 100,
  pricing_strategy: 'sum', free_selections: 0, sort: grupo.sort,
  is_meal_part: grupo.isMealPart, loose_price: grupo.loosePrice, ...extra,
})

const opcionDelCatalogo = choice => ({
  id: choice.optionId, option_group_id: choice.groupId, name: choice.name,
  price_adjustment: choice.price, stock: 'disponible', sort: choice.sort,
})

const CATALOGO = {
  products: [ALMUERZO],
  variants: [],
  optionGroups: [grupoDelCatalogo(SOPA), grupoDelCatalogo(SEGUNDO), grupoDelCatalogo(ACOMPANAR)],
  options: [CALDO(1), CREMA(1), POLLO(1), CEVICHE(1), JUGO(1), CARNE(1)].map(opcionDelCatalogo),
  deliveryFee: 1.5,
  fulfillment: 'pickup',
}

const pedirMesa = (choices, extra = {}) => ({
  productId: 'alm',
  quantity: 1,
  options: choices.map(c => ({ optionId: c.optionId, quantity: c.quantity })),
  ...extra,
})

const cotizar = (items, extra = {}) => quoteCart({ items, ...CATALOGO, ...extra })

describe('cotizar el plato por partes', () => {
  const FAMILIA = [CEVICHE(1), CALDO(2), POLLO(2), JUGO(3), CARNE(1)]

  it('devuelve las mismas líneas que va a crear la base', () => {
    const r = cotizar([pedirMesa(FAMILIA)])
    expect(r.error).toBeUndefined()
    expect(r.lines.map(l => [l.name, l.quantity, l.unitPrice, l.lineTotal])).toEqual([
      ['Almuerzo del día', 2, 3, 6],
      ['Solo segundo', 1, 2.5, 2.5],
      ['Porción de carne', 1, 0.5, 0.5],
    ])
    expect(r.subtotal).toBe(9)
  })

  it('el margen de la plataforma se suma por línea, como en la base', () => {
    const r = cotizar([pedirMesa(FAMILIA)], {
      pricing: {
        markupMode: 'on_top', strategy: 'percentage', percentage: 10,
        minAmount: null, maxAmount: null,
      },
    })
    // 0.30 × 2 + 0.25 + 0.05 = 0.90 sobre los 9.00 del comercio.
    expect(r.total).toBe(9.9)
  })

  it('el plato va en UNA línea del pedido: con cantidad 2 se rechaza', () => {
    expect(cotizar([pedirMesa(FAMILIA, { quantity: 2 })]).error)
      .toBe('Almuerzo del día se arma en una sola línea')
  })

  it('repetirlo en dos líneas partiría la mesa y abarataría el almuerzo', () => {
    expect(cotizar([pedirMesa([CALDO(1)]), pedirMesa([POLLO(1)])]).error)
      .toBe('Almuerzo del día va una sola vez en el pedido')
  })

  it('una parte AGOTADA entera deja de contar para formar el almuerzo', () => {
    const sinSegundos = {
      options: CATALOGO.options.map(o => (o.option_group_id === SEGUNDO.id
        ? { ...o, stock: 'agotado' }
        : o)),
    }
    const r = cotizar([pedirMesa([CALDO(1)])], sinSegundos)
    expect(r.lines.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([
      ['Almuerzo del día', 1, 3],
    ])
  })

  it('un producto sin partes se cotiza exactamente como antes', () => {
    const normal = { ...ALMUERZO, id: 'cola', name: 'Cola', price: 1 }
    const r = cotizar([{ productId: 'cola', quantity: 3 }], {
      products: [ALMUERZO, normal],
    })
    expect(r.lines.map(l => [l.name, l.quantity, l.unitPrice])).toEqual([['Cola', 3, 1]])
  })
})

// ── El catálogo: lo que la app necesita para pintar la mesa ────────────────

describe('el catálogo del plato por partes', () => {
  const { buildStorefrontCatalog } = require('../dist/services/storefront')

  const catalogo = (pricing = null) => buildStorefrontCatalog({
    categories: [],
    products: [ALMUERZO],
    variants: [],
    extras: [],
    optionGroups: CATALOGO.optionGroups,
    // El caldo trae un recargo guardado: dentro de una parte no debe verse.
    options: CATALOGO.options.map(o => (o.id === 'o-caldo' ? { ...o, price_adjustment: 0.75 } : o)),
    pricing,
  })
  const grupo = (cat, id) => cat.products[0].optionGroups.find(g => g.id === id)

  it('cada parte dice que lo es y cuánto cuesta suelta', () => {
    expect(grupo(catalogo(), 'g-sopa')).toMatchObject({ isMealPart: true, loosePrice: 1.5 })
    expect(grupo(catalogo(), 'g-acompanar')).toMatchObject({ isMealPart: false, loosePrice: null })
  })

  it('una porción de una parte no tiene precio propio, aunque la opción lo traiga', () => {
    expect(grupo(catalogo(), 'g-sopa').options.find(o => o.id === 'o-caldo').price).toBe(0)
  })

  it('el precio suelto y lo que acompaña salen con el margen de la tienda', () => {
    const conMargen = catalogo({
      markupMode: 'on_top', strategy: 'percentage', percentage: 10,
      minAmount: null, maxAmount: null,
    })
    expect(grupo(conMargen, 'g-segundo').loosePrice).toBe(2.75)
    expect(grupo(conMargen, 'g-acompanar').options.find(o => o.id === 'o-carne').price).toBe(0.55)
  })
})
