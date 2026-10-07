import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { calculatePlatformMarkup } = require('../dist/services/platform-pricing.js')
const { precioDeVitrina, reglaDeMargen, publicBusiness } = require('../dist/services/storefront.js')
const { quoteCart } = require('../dist/services/cotizacion.js')

// ═══════════════════════════════════════════════════════════════════════════
// EL MARGEN SE SUMA AL PRECIO, NO SE LE QUITA AL DUEÑO (2026-08-25)
//
// Hasta hoy, sobre un pedido de $8: el cliente pagaba $8, el comercio recibía
// $7,20 y la plataforma $0,80. Los datos de producción lo confirmaban — en 5
// pedidos los clientes pagaron $64,95 y el comercio recibió $47,25.
//
// El dueño de un local pone el precio al que QUIERE VENDER. Quitarle una parte
// lo convierte en un descuento forzoso que nunca pactó.
// ═══════════════════════════════════════════════════════════════════════════

const REGLA = (pct, extra = {}) => ({
  strategy: 'percentage', percentage: pct, markupMode: 'on_top', ...extra,
})

describe('los casos del modelo económico', () => {
  // Los cinco casos mínimos que el dueño exigió por escrito.
  it('caso 1 — $5 al 10%: el comercio cobra $5 y el cliente $5,50', () => {
    const r = calculatePlatformMarkup(5, REGLA(10))
    expect(r.merchantSubtotal).toBe(5)
    expect(r.markup).toBe(0.5)
    expect(r.customerSubtotal).toBe(5.5)
  })

  it('caso 2 — $8 al 10%: el comercio cobra $8, la plataforma $0,80', () => {
    const r = calculatePlatformMarkup(8, REGLA(10))
    expect(r.merchantSubtotal).toBe(8)
    expect(r.markup).toBe(0.8)
    expect(r.customerSubtotal).toBe(8.8)
  })

  it('caso 3 — $10 al 5%', () => {
    const r = calculatePlatformMarkup(10, REGLA(5))
    expect(r.merchantSubtotal).toBe(10)
    expect(r.markup).toBe(0.5)
  })

  it('caso 4 — 0%: la plataforma no cobra nada y el comercio cobra todo', () => {
    const r = calculatePlatformMarkup(10, REGLA(0))
    expect(r.merchantSubtotal).toBe(10)
    expect(r.markup).toBe(0)
    expect(r.customerSubtotal).toBe(10)
  })

  // ⚠️ El caso que el dueño nombró por su nombre: $4,99 al 10% son $0,499.
  // Tiene que existir UNA regla y la misma en todo el sistema.
  it('$4,99 al 10% redondea a $0,50, y el cliente paga $5,49', () => {
    const r = calculatePlatformMarkup(4.99, REGLA(10))
    expect(r.markup).toBe(0.5)
    expect(r.merchantSubtotal).toBe(4.99)
    expect(r.customerSubtotal).toBe(5.49)
  })

  // El comercio NUNCA puede acabar debiendo dinero por haber vendido.
  it('un piso mayor que el pedido no deja al comercio en negativo', () => {
    const r = calculatePlatformMarkup(2, REGLA(10, { minAmount: 5 }))
    expect(r.markup).toBeLessThanOrEqual(2)
    expect(r.merchantSubtotal).toBeGreaterThanOrEqual(0)
  })

  // `absorbed` sigue existiendo: los pedidos viejos se liquidan como se cobraron.
  it('`absorbed` se conserva y sigue descontando, para los pedidos ya sellados', () => {
    const r = calculatePlatformMarkup(8, { ...REGLA(10), markupMode: 'absorbed' })
    expect(r.merchantSubtotal).toBe(7.2)
    expect(r.customerSubtotal).toBe(8)
  })
})

describe('el precio que ve el cliente en la vitrina', () => {
  it('con on_top al 10%, $5,00 se pinta $5,50', () => {
    expect(precioDeVitrina(5, REGLA(10))).toBe(5.5)
  })

  // Con `absorbed` el margen ya sale del precio del comercio: el cliente ya
  // está viendo lo que paga, y sumarle nada sería cobrarle dos veces.
  it('con absorbed NO se toca el precio', () => {
    expect(precioDeVitrina(5, { ...REGLA(10), markupMode: 'absorbed' })).toBe(5)
  })

  it('sin regla, el cliente ve el precio del comercio', () => {
    expect(precioDeVitrina(5, null)).toBe(5)
  })

  // ⚠️ `fixed` y `tiered` son cantidades del PEDIDO ENTERO. Repartirlas por
  // producto daría un precio unitario que no existe, y al sumar el carrito no
  // cuadraría con el cobro.
  it('las estrategias por pedido NO se reparten por producto', () => {
    expect(precioDeVitrina(5, { strategy: 'fixed', fixedAmount: 1, markupMode: 'on_top' })).toBe(5)
    expect(precioDeVitrina(5, { strategy: 'tiered', tiers: [{ amount: 1 }], markupMode: 'on_top' })).toBe(5)
  })

  // Un tope del pedido tampoco puede prorratearse: dos productos con techo de
  // $1 no llevan $1 cada uno.
  it('con topes de pedido tampoco se pinta', () => {
    expect(precioDeVitrina(5, REGLA(10, { maxAmount: 1 }))).toBe(5)
    expect(precioDeVitrina(5, REGLA(10, { minAmount: 1 }))).toBe(5)
  })

  it('un precio ausente sigue ausente', () => {
    expect(precioDeVitrina(null, REGLA(10))).toBeNull()
  })
})

describe('la regla que llega de la base', () => {
  it('se normaliza a lo que espera el motor', () => {
    const r = reglaDeMargen({
      rule_id: 'abc', version: 3, mode: 'on_top', strategy: 'percentage',
      percentage: '10.0000', min_amount: null, max_amount: null,
    })
    expect(r).toMatchObject({ strategy: 'percentage', percentage: 10, markupMode: 'on_top', version: 3 })
  })

  // Falla hacia `absorbed`, que es no cobrarle de más a nadie.
  it('un modo desconocido no se convierte en on_top', () => {
    expect(reglaDeMargen({ strategy: 'percentage', mode: 'inventado' }).markupMode).toBe('absorbed')
  })

  it('sin regla devuelve null', () => {
    expect(reglaDeMargen(null)).toBeNull()
    expect(reglaDeMargen({})).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA COTIZACIÓN: el número que se enseña antes de pagar
// ═══════════════════════════════════════════════════════════════════════════
describe('el desglose del carrito', () => {
  const PRODUCTO = (id, price) => ({
    id, name: `P${id}`, price, price_sale: null, stock: 'disponible',
    active: true, category_id: null,
  })
  const cotizar = (items, pricing, deliveryFee = 0, fulfillment = 'pickup') => quoteCart({
    items, products: [PRODUCTO('a', 5), PRODUCTO('b', 2), PRODUCTO('c', 1)],
    variants: [], optionGroups: [], options: [], deliveryFee, fulfillment, pricing,
  })

  it('varios productos: el comercio cobra $8 y el cliente $8,80', () => {
    const q = cotizar([
      { productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 1 },
    ], REGLA(10))
    expect(q.error).toBeFalsy()
    expect(q.subtotal).toBe(8)
    expect(q.merchantSubtotal).toBe(8)
    expect(q.platformMarkup).toBe(0.8)
    expect(q.customerSubtotal).toBe(8.8)
    expect(q.total).toBe(8.8)
  })

  it('cantidades mayores que 1: 2×$5 + 1×$2 + 2×$1 = $14', () => {
    const q = cotizar([
      { productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 2 },
    ], REGLA(10))
    expect(q.merchantSubtotal).toBe(14)
    expect(q.platformMarkup).toBe(1.4)
    expect(q.customerSubtotal).toBe(15.4)
  })

  // ⚠️ EL MARGEN NO SE COBRA SOBRE EL ENVÍO. $8 + 10% + $1,50 = $10,30, nunca
  // el 10% de $9,50.
  it('caso 5 — el envío queda FUERA del margen', () => {
    const q = cotizar([
      { productId: 'a', quantity: 1 }, { productId: 'b', quantity: 1 }, { productId: 'c', quantity: 1 },
    ], REGLA(10), 1.5, 'delivery')
    expect(q.merchantSubtotal).toBe(8)
    expect(q.platformMarkup).toBe(0.8)
    expect(q.shipping).toBe(1.5)
    expect(q.total).toBe(10.3)
  })

  it('sin regla, el cliente paga el precio del comercio', () => {
    const q = cotizar([{ productId: 'a', quantity: 1 }], null)
    expect(q.merchantSubtotal).toBe(5)
    expect(q.platformMarkup).toBe(0)
    expect(q.total).toBe(5)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE LA BASE GARANTIZA
// ═══════════════════════════════════════════════════════════════════════════
describe('el sellado del pedido', () => {
  const MIGRACION = readFileSync(
    fileURLToPath(new URL('../migration-2026-08-29-margen-sobre-el-precio.sql', import.meta.url)), 'utf8')
  const ESQUEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')

  it('on_top deja de estar prohibido, en la migración y en el consolidado', () => {
    for (const [donde, sql] of [['migración', MIGRACION], ['schema.sql', ESQUEMA]]) {
      expect(sql, donde).toMatch(/check \(markup_mode in \('absorbed', 'on_top'\)\)/)
      expect(sql, donde).not.toMatch(/check \(markup_mode = 'absorbed'\)/)
    }
  })

  // ⚠️ EL DISPARADOR NO SE TOCA, y esta prueba existe para que siga así.
  //
  // La primera versión de esta entrega lo reescribía y habría DEGRADADO dos
  // cosas que ya hacía bien: calcular el margen POR LÍNEA —para que el total
  // coincida con lo que el cliente sumó en pantalla— y restar el descuento de
  // la base antes de aplicar el porcentaje. Lo cazó el CI, porque `schema.sql`
  // acumula TRES redefiniciones de esa función y manda la última: leer solo la
  // primera engaña.
  it('la migración NO reescribe orders_stamp_pricing', () => {
    expect(MIGRACION).not.toMatch(/function public\.orders_stamp_pricing/)
  })

  it('el disparador vigente sigue calculando por línea y restando el descuento', () => {
    const ultima = ESQUEMA.lastIndexOf('create or replace function public.orders_stamp_pricing')
    const fn = ESQUEMA.slice(ultima, ESQUEMA.indexOf('$$;', ultima))
    expect(fn, 'el margen por línea hace que el total cuadre con la pantalla')
      .toMatch(/order_markup_by_line/)
    expect(fn, 'el descuento sale de la base antes del porcentaje')
      .toMatch(/coalesce\(new\.discount, 0\)/)
    expect(fn, 'con on_top el comercio conserva su precio entero')
      .toMatch(/new\.merchant_subtotal := v_base/)
  })

  it('la función del dinero tampoco se recrea', () => {
    expect(MIGRACION).not.toMatch(/create or replace function public\.create_storefront_order/)
  })

  // El catálogo necesita el porcentaje ANTES de que exista un pedido, y tiene
  // que salir de la MISMA jerarquía que cobra: negocio → tipo → global.
  it('la vista del catálogo respeta la jerarquía del cobro', () => {
    const fn = MIGRACION.slice(MIGRACION.indexOf('function public.business_pricing_view'))
    expect(fn).toMatch(/when 'business'\s+then 1/)
    expect(fn).toMatch(/when 'business_type' then 2/)
    expect(fn).toMatch(/when 'global'\s+then 3/)
    expect(fn).toMatch(/pr\.status = 'active'/)
    expect(fn).toMatch(/effective_until is null or pr\.effective_until > now\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL MÍNIMO DE COMPRA VIAJA EN LA MONEDA DEL CLIENTE
//
// El dueño fija su mínimo sobre SU precio, y la base lo exige así
// (`orders_enforce_min_amount` mira `orders.subtotal`). Pero la app compara
// contra un carrito ya con margen: si el mínimo no se inflara igual, un
// carrito de $4,80 del comercio —$5,28 para el cliente— parecería llegar a un
// mínimo de $5 y la base lo rechazaría justo al confirmar.
// ═══════════════════════════════════════════════════════════════════════════
describe('el mínimo de compra con margen', () => {
  const NEGOCIO = {
    id: 'b1', name: 'Local', slug: 'local', type: 'pizzería',
    delivery_fee: 2, prep_time_minutes: 25, delivery_extra_minutes: 10,
    min_order_amount: 5, payment_methods: null,
  }

  it('se infla igual que los precios, para que la comparación siga siendo la misma', () => {
    const conRegla = publicBusiness(NEGOCIO, REGLA(10))
    expect(conRegla.minOrderAmount).toBe(5.5)

    // Equivalencia: un carrito justo en el mínimo del comercio lo sigue estando
    // en la moneda del cliente, y uno por debajo sigue por debajo.
    const enElMinimo = calculatePlatformMarkup(5, REGLA(10)).customerSubtotal
    const porDebajo = calculatePlatformMarkup(4.8, REGLA(10)).customerSubtotal
    expect(enElMinimo).toBeGreaterThanOrEqual(conRegla.minOrderAmount)
    expect(porDebajo).toBeLessThan(conRegla.minOrderAmount)
  })

  it('sin regla, el mínimo es el que puso el dueño', () => {
    expect(publicBusiness(NEGOCIO, null).minOrderAmount).toBe(5)
  })

  // ⚠️ El envío NO lleva margen: se cobra aparte y el margen sale solo de los
  // productos.
  it('el envío no se infla', () => {
    expect(publicBusiness(NEGOCIO, REGLA(10)).deliveryFee).toBe(2)
  })
})

// ── EL NÚMERO POR EL QUE SE MANDA EL COMPROBANTE ──────────────────────────
//
// Desde que todos los locales viven en el marketplace, `whatsapp_number` y
// `phone` son NULL para todos los negocios, siempre. Sin este respaldo la app
// recibía `phone: null` y se apagaban cuatro salidas, entre ellas la única vía
// para mandar el comprobante. No es cosmético: impide pagar.
describe('el teléfono público cae al número del marketplace', () => {
  const LOCAL = { id: 'b1', name: 'Monster Pizza', slug: 'monster-pizza' }
  const PLATAFORMA = '+593991716574'

  it('sin número propio, sale el de la plataforma', () => {
    expect(publicBusiness(LOCAL, null, PLATAFORMA).phone).toBe(PLATAFORMA)
  })

  // ⚠️ El CANAL del local gana siempre. Un negocio con canal propio recibe a
  // sus clientes en su número; mandarlos al del marketplace le quitaría la
  // conversación y rompería el enrutado, que pasa por ahí.
  // ⚠️ Ni con `whatsapp_number` cargado (2026-09-07). El canal propio se retiró
  // del panel el 2026-08-23 y el dueño lo cerró del todo: en Umbani el cliente
  // escribe SIEMPRE al número de la plataforma.
  it('ni con un número propio en la ficha se cambia el de la plataforma', () => {
    expect(publicBusiness({ ...LOCAL, whatsapp_number: '+593900111222' }, null, PLATAFORMA).phone)
      .toBe(PLATAFORMA)
  })

  // ⚠️ Y `businesses.phone` NO es un canal (2026-09-07, corrección del dueño).
  // El enrutado va por `business_channel_identifiers` —`(provider,
  // identifier_type, canonical_identifier)`—, nunca por este campo. Aquí vive
  // el teléfono de CONTACTO del dueño, el mismo con el que pide sus reportes.
  // Estaba latente: con el campo vacío caía al número de la plataforma y
  // parecía correcto; se dispara el día que alguien rellena la ficha.
  it('el teléfono de contacto del dueño NO se le da al cliente', () => {
    expect(publicBusiness({ ...LOCAL, phone: '+593900333444' }, null, PLATAFORMA).phone)
      .toBe(PLATAFORMA)
  })

  // Sin plataforma configurada se vuelve al estado anterior: null, y la app
  // esconde los botones. Peor que tenerlos, pero mejor que mandar a nadie.
  it('sin plataforma configurada devuelve null, no una cadena vacía', () => {
    expect(publicBusiness(LOCAL, null, null).phone).toBeNull()
    expect(publicBusiness(LOCAL).phone).toBeNull()
  })

  // ⚠️ Que salga el MISMO número para dos locales es correcto: por ahí
  // escriben los clientes de todos. El pedido NO se desambigua por el número
  // —sale del pedido—, así que esto no puede mezclar el dinero de dos locales.
  it('dos locales distintos pueden compartir el número del marketplace', () => {
    const a = publicBusiness({ ...LOCAL, id: 'b1' }, null, PLATAFORMA)
    const b = publicBusiness({ ...LOCAL, id: 'b2', slug: 'cevicheria' }, null, PLATAFORMA)
    expect(a.phone).toBe(b.phone)
    expect(a.id).not.toBe(b.id)
  })
})
