import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { quoteCart } = require('../dist/services/cotizacion')

// ═══════════════════════════════════════════════════════════════════════════
// COTIZAR EL CARRITO
// ═══════════════════════════════════════════════════════════════════════════
//
// El número que el cliente ve JUSTO ANTES de pagar. No cobra —eso lo hace
// `create_storefront_order`—, pero si dijera algo distinto de lo que la RPC va
// a cobrar, el cliente confirmaría un precio y le llegaría otro.
//
// Por eso comprueba las mismas fronteras que la RPC: pertenencia de la opción,
// grupos obligatorios y estrategias de precio.

const PRODUCTO = {
  id: 'p1', name: 'Pizza', price: 10, price_sale: null,
  stock: 'disponible', category_id: 'cat1',
}

const GRUPO_MITADES = {
  id: 'g-mitades', product_id: 'p1', category_id: null, name: 'Mitades',
  selection_type: 'multiple', required: true, min_selectable: 2,
  max_selectable: 2, pricing_strategy: 'highest_selected', free_selections: 0,
}

const SUPREMA = { id: 'o-sup', option_group_id: 'g-mitades', name: 'Media Suprema', price_adjustment: 10, stock: 'disponible' }
const HAWAIANA = { id: 'o-haw', option_group_id: 'g-mitades', name: 'Media Hawaiana', price_adjustment: 9, stock: 'disponible' }

const cotizar = (items, extra = {}) => quoteCart({
  items,
  products: [PRODUCTO],
  variants: [],
  optionGroups: [GRUPO_MITADES],
  options: [SUPREMA, HAWAIANA],
  deliveryFee: 1.5,
  fulfillment: 'pickup',
  ...extra,
})

const MITADES = [
  { optionId: 'o-sup', quantity: 1 },
  { optionId: 'o-haw', quantity: 1 },
]

describe('cotizar el carrito', () => {
  it('aplica la estrategia del grupo, no la suma', () => {
    // 10 de base + la mitad más cara (10) = 20. Sumando serían 29.
    const r = cotizar([{ productId: 'p1', quantity: 1, options: MITADES }])
    expect(r.error).toBeUndefined()
    expect(r.total).toBe(20)
    expect(r.lines[0].unitPrice).toBe(20)
  })

  it('multiplica por la cantidad de la línea', () => {
    const r = cotizar([{ productId: 'p1', quantity: 3, options: MITADES }])
    expect(r.lines[0].lineTotal).toBe(60)
    expect(r.subtotal).toBe(60)
  })

  it('devuelve el desglose de lo elegido, para que el cliente lo revise', () => {
    const r = cotizar([{ productId: 'p1', quantity: 1, options: MITADES }])
    expect(r.lines[0].options).toEqual([
      { name: 'Media Suprema', groupName: 'Mitades', quantity: 1, price: 10 },
      { name: 'Media Hawaiana', groupName: 'Mitades', quantity: 1, price: 9 },
    ])
  })

  it('el envío solo se cobra a domicilio', () => {
    const items = [{ productId: 'p1', quantity: 1, options: MITADES }]
    expect(cotizar(items).shipping).toBe(0)
    expect(cotizar(items, { fulfillment: 'delivery' }).shipping).toBe(1.5)
    expect(cotizar(items, { fulfillment: 'delivery' }).total).toBe(21.5)
  })
})

describe('lo que la cotización rechaza, para no prometer un precio imposible', () => {
  it('un carrito vacío no se cotiza', () => {
    expect(cotizar([]).lines).toEqual([])
  })

  it('un producto que ya no existe', () => {
    const r = cotizar([{ productId: 'fantasma', quantity: 1 }])
    expect(r.error).toMatch(/ya no está disponible/)
  })

  it('un producto agotado', () => {
    const r = quoteCart({
      items: [{ productId: 'p1', quantity: 1, options: MITADES }],
      products: [{ ...PRODUCTO, stock: 'agotado' }],
      variants: [], optionGroups: [GRUPO_MITADES], options: [SUPREMA, HAWAIANA],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    expect(r.error).toMatch(/agotado/)
  })

  it('una cantidad fuera de rango', () => {
    expect(cotizar([{ productId: 'p1', quantity: 0 }]).error).toMatch(/cantidad/)
    expect(cotizar([{ productId: 'p1', quantity: 200 }]).error).toMatch(/cantidad/)
  })

  // La misma frontera que aplica la RPC: sin esto se abarataría una pizza
  // mandando el id de una opción de otro plato.
  it('una opción que no es de este producto', () => {
    const ajena = {
      id: 'o-ajena', option_group_id: 'g-otro', name: 'De otro plato',
      price_adjustment: -5, stock: 'disponible',
    }
    const r = quoteCart({
      items: [{ productId: 'p1', quantity: 1, options: [{ optionId: 'o-ajena', quantity: 1 }] }],
      products: [PRODUCTO],
      variants: [],
      optionGroups: [
        GRUPO_MITADES,
        { ...GRUPO_MITADES, id: 'g-otro', product_id: 'otro-producto', required: false, min_selectable: 0 },
      ],
      options: [SUPREMA, HAWAIANA, ajena],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    expect(r.error).toMatch(/no corresponde a Pizza/)
  })

  it('una opción agotada', () => {
    const r = quoteCart({
      items: [{ productId: 'p1', quantity: 1, options: MITADES }],
      products: [PRODUCTO], variants: [], optionGroups: [GRUPO_MITADES],
      options: [{ ...SUPREMA, stock: 'agotado' }, HAWAIANA],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    expect(r.error).toMatch(/ya no está disponible/)
  })

  // Cotizar algo que la RPC va a rechazar dejaría al cliente confirmando una
  // pantalla que no existe.
  it('un grupo obligatorio sin completar', () => {
    const r = cotizar([{
      productId: 'p1', quantity: 1,
      options: [{ optionId: 'o-sup', quantity: 1 }],
    }])
    expect(r.error).toMatch(/Falta elegir Mitades/)
  })

  it('una presentación que no es de este producto', () => {
    const r = quoteCart({
      items: [{ productId: 'p1', variantId: 'v-ajena', quantity: 1, options: MITADES }],
      products: [PRODUCTO],
      variants: [{ id: 'v-ajena', product_id: 'otro', name: 'Familiar', price: 1 }],
      optionGroups: [GRUPO_MITADES], options: [SUPREMA, HAWAIANA],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    expect(r.error).toMatch(/no es de este producto/)
  })

  // ── El tope de arriba, que faltaba ────────────────────────────────────────
  //
  // Hasta el 2026-08-09 solo se comprobaba el mínimo. Una pizza con TRES
  // sabores teniendo el tope en dos se cotizaba sin queja —con su precio y
  // todo— y reventaba al confirmar con «Demasiadas opciones»: el cliente veía
  // un número y le llegaba otro, que es justo lo que esta función existe para
  // evitar. La app bloquea al llegar al máximo, pero la app no es la defensa.
  it('rechaza pasarse del máximo del grupo', () => {
    const TERCERA = {
      id: 'o-ter', option_group_id: 'g-mitades', name: 'Media Carnívora',
      price_adjustment: 12, stock: 'disponible',
    }
    const r = quoteCart({
      items: [{
        productId: 'p1', quantity: 1,
        options: [
          { optionId: 'o-sup', quantity: 1 },
          { optionId: 'o-haw', quantity: 1 },
          { optionId: 'o-ter', quantity: 1 },
        ],
      }],
      products: [PRODUCTO], variants: [],
      optionGroups: [GRUPO_MITADES], options: [SUPREMA, HAWAIANA, TERCERA],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    // Mismo texto que la RPC: el cliente lee lo mismo venga de donde venga.
    expect(r.error).toMatch(/Demasiadas opciones en Mitades/)
  })

  // En un contador el tope es de PORCIONES, no de opciones marcadas: una
  // parrillada de 4 se cumple con un corte pedido 4 veces. Si aquí se contaran
  // las opciones, «6 salsas de ajo» pasaría por ser una sola marcada.
  it('en los contadores el tope cuenta porciones, no opciones marcadas', () => {
    const SALSAS = {
      id: 'g-salsas', product_id: 'p1', category_id: null, name: 'Salsas',
      selection_type: 'quantity', required: false, min_selectable: 0,
      max_selectable: 3, pricing_strategy: 'sum', free_selections: 0,
    }
    const AJO = {
      id: 'o-ajo', option_group_id: 'g-salsas', name: 'Salsa de ajo',
      price_adjustment: 0.5, stock: 'disponible',
    }
    const cotizarSalsas = porciones => quoteCart({
      items: [{ productId: 'p1', quantity: 1, options: [{ optionId: 'o-ajo', quantity: porciones }] }],
      products: [PRODUCTO], variants: [],
      optionGroups: [{ ...GRUPO_MITADES, required: false, min_selectable: 0 }, SALSAS],
      options: [SUPREMA, HAWAIANA, AJO],
      deliveryFee: 0, fulfillment: 'pickup',
    })

    expect(cotizarSalsas(3).error).toBeUndefined()
    expect(cotizarSalsas(4).error).toMatch(/Demasiadas opciones en Salsas/)
  })

  // Los descuentos acumulados no pueden regalar el plato; la RPC lo rechaza
  // igual, así que cotizarlo sería prometer algo que no se va a cumplir.
  it('un plato que quedaría en cero por recargos negativos', () => {
    const r = quoteCart({
      items: [{ productId: 'p1', quantity: 1, options: [{ optionId: 'o-sup', quantity: 1 }] }],
      products: [{ ...PRODUCTO, price: 1 }],
      variants: [],
      optionGroups: [{ ...GRUPO_MITADES, required: false, min_selectable: 0, pricing_strategy: 'sum' }],
      options: [{ ...SUPREMA, price_adjustment: -5 }],
      deliveryFee: 0, fulfillment: 'pickup',
    })
    expect(r.error).toMatch(/sin precio válido/)
  })
})
