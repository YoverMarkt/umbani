import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEGOCIO_ABIERTO, db, ejecutar } from './manejadores-de-la-tienda.mjs'

// Las pruebas de comportamiento de la mini app (ver `tienda-crear-pedido.test.js`):
// las direcciones, «Mis pedidos», la cotización y lo que el cliente consulta.

// ── El pin de la dirección ─────────────────────────────────────────────────
//
// La ubicación decide a dónde va un repartidor. Lo que se prueba aquí es que
// ningún fallo del navegador deje al cliente sin poder pedir, y que lo que se
// guarda sea un punto de verdad y no medio dato con pinta de dato.
describe('la ubicación de la dirección', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' }
  const DIRECCION = { label: 'Casa', address: 'Calle 4 de Mayo 37' }

  afterEach(() => vi.restoreAllMocks())

  it('guarda el pin y su precisión cuando el cliente lo comparte', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: {
        ...DIRECCION,
        latitude: -1.0546211, longitude: -80.454472, accuracy: 12.55,
        buildingType: 'departamento', courierNotes: 'el timbre no sirve',
      },
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: -1.0546211,
      longitude: -80.454472,
      accuracyM: 12.6,
      buildingType: 'departamento',
      courierNotes: 'el timbre no sirve',
    }))
  })

  // El pin es OPCIONAL. Quien niega el permiso —o abre el enlace dentro de
  // WhatsApp, que no siempre lo reenvía— tiene que poder pedir igual: perder
  // la venta por un dato de ayuda es peor que repartir con la dirección
  // escrita, que es como se repartió siempre.
  it('sin ubicación la dirección se guarda igual', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION, params: { slug: 'pizzeria' }, body: DIRECCION,
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: null, longitude: null, accuracyM: null,
    }))
  })

  // Media coordenada no es medio pin: es un punto en el ecuador o en
  // Greenwich, que es PEOR que no tener nada porque parece un dato.
  it('rechaza media coordenada en vez de guardar un punto inventado', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    for (const mitad of [{ latitude: -1.05 }, { longitude: -80.45 }]) {
      const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
        storefront: SESION, params: { slug: 'pizzeria' }, body: { ...DIRECCION, ...mitad },
      })
      expect(respuesta.status).toBe(400)
      expect(respuesta.body.error).toBe('La ubicación llegó incompleta')
    }
    expect(crear).not.toHaveBeenCalled()
  })

  it('rechaza coordenadas fuera del planeta antes de que las rechace el CHECK', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    for (const fuera of [
      { latitude: 200, longitude: 0 },
      { latitude: 0, longitude: -900 },
      { latitude: 'aquí', longitude: 'allá' },
    ]) {
      const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
        storefront: SESION, params: { slug: 'pizzeria' }, body: { ...DIRECCION, ...fuera },
      })
      expect(respuesta.status).toBe(400)
      expect(respuesta.body.error).toBe('La ubicación no es válida')
    }
    expect(crear).not.toHaveBeenCalled()
  })

  // La precisión es accesoria: el punto vale aunque no sepamos cuánto se
  // equivoca. Descartarla es mejor que tumbar el dato bueno por el adorno.
  it('una precisión rara se descarta sin tumbar el pin', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: { ...DIRECCION, latitude: -1.05, longitude: -80.45, accuracy: -5 },
    })

    expect(respuesta.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({
      latitude: -1.05, longitude: -80.45, accuracyM: null,
    }))
  })

  it('un tipo de edificio inventado no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createCustomerAddress')

    const respuesta = await ejecutar('/api/store/:slug/addresses', 'post', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
      body: { ...DIRECCION, buildingType: 'castillo' },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  // ── Ponerle el pin a una dirección que ya existía ────────────────────────

  it('le pone la ubicación a una dirección guardada', async () => {
    const ubicar = vi.spyOn(db, 'setCustomerAddressLocation')
      .mockResolvedValue({ id: 'dir-1', latitude: -1.05 })

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-1' },
      body: { latitude: -1.05, longitude: -80.45, accuracy: 9 },
    })

    expect(respuesta.status).toBe(200)
    expect(ubicar).toHaveBeenCalledWith({
      businessId: 'negocio-a',
      customerId: 'cliente-1',
      addressId: 'dir-1',
      latitude: -1.05,
      longitude: -80.45,
      accuracyM: 9,
    })
  })

  // Regla #1: la dirección de otro cliente no se mueve ni sabiendo su id. El
  // `where` de la consulta lleva negocio Y cliente, y aquí se comprueba que la
  // ruta no invente un 200 cuando la base no encontró nada suyo.
  it('una dirección ajena responde 404, sin decir que existe', async () => {
    vi.spyOn(db, 'setCustomerAddressLocation').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-de-otro' },
      body: { latitude: -1.05, longitude: -80.45 },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toBe('Esa dirección no existe')
  })

  it('sin ubicación no se llama a la base: no hay nada que guardar', async () => {
    const ubicar = vi.spyOn(db, 'setCustomerAddressLocation')

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id/location', 'put', {
      storefront: SESION, params: { slug: 'pizzeria', id: 'dir-1' }, body: {},
    })

    expect(respuesta.status).toBe(400)
    expect(ubicar).not.toHaveBeenCalled()
  })
})

// ── Retirar una dirección ──────────────────────────────────────────────────
//
// Se marca inactiva, no se borra: `orders.address_id` apunta aquí y con él se
// sabe a qué casa pide más un cliente. El destino de cada pedido va congelado
// aparte desde el 2026-08-10, así que retirarla no deja ningún reparto sin
// dirección — antes sí lo habría hecho.
describe('eliminar una dirección', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' }

  afterEach(() => vi.restoreAllMocks())

  it('la retira con el negocio y el cliente de la sesión', async () => {
    const retirar = vi.spyOn(db, 'deactivateCustomerAddress').mockResolvedValue({ id: 'dir-1' })

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id', 'delete', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-1' },
    })

    expect(respuesta.status).toBe(200)
    // ⚠️ REGLA #1: el negocio y el cliente salen de la sesión, nunca de la URL.
    expect(retirar).toHaveBeenCalledWith({
      businessId: 'negocio-a', customerId: 'cliente-1', addressId: 'dir-1',
    })
  })

  // Decir «existe pero no es tuya» ya sería contar algo de otro cliente.
  it('una dirección ajena responde 404, igual que una que no existe', async () => {
    vi.spyOn(db, 'deactivateCustomerAddress').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/addresses/:id', 'delete', {
      storefront: SESION,
      params: { slug: 'pizzeria', id: 'dir-de-otro' },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toBe('Esa dirección no existe')
  })
})

// ── Mis pedidos ────────────────────────────────────────────────────────────
//
// La pestaña de abajo abría el ÚLTIMO pedido directamente. Servía mientras
// solo hubiera uno del que preocuparse; quien ha pedido cinco veces tiene un
// historial, no «un pedido».
describe('la lista de mis pedidos', () => {
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '593999' }

  afterEach(() => vi.restoreAllMocks())

  // ⚠️ REGLA #1 con un matiz propio de la tienda: aquí no hay JWT, la
  // credencial es el enlace. El teléfono de la SESIÓN es lo único que separa
  // «mis pedidos» de «la bandeja del local».
  it('filtra por el negocio y el teléfono de la sesión', async () => {
    const leer = vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({ data: [], error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION,
      params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(200)
    expect(leer).toHaveBeenCalledWith({ businessId: 'negocio-a', contactPhone: '593999' })
  })

  // La lista pinta lo que se pidió, igual que el pedido suelto: sin agrupar,
  // cada línea saldría con el nombre a secas y dos pizzas distintas se leerían
  // idénticas en el historial.
  it('devuelve las opciones ya agrupadas', async () => {
    vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({
      data: [{
        id: 'p1',
        order_items: [{
          product_name: 'Pizza',
          order_item_options: [
            { option_group_name: 'Sabor', option_name: 'Criolla', quantity: 1, group_sort: 0 },
          ],
        }],
      }],
      error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.body[0].order_items[0].options).toEqual([
      { group: 'Sabor', items: [{ name: 'Criolla', quantity: 1 }] },
    ])
  })

  it('un fallo de la base responde 500, no una lista vacía que parece cierta', async () => {
    vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({
      data: null, error: { message: 'se cayó' },
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE EL CLIENTE VE DE SU DINERO
// ═══════════════════════════════════════════════════════════════════════════
//
// Añadido el 2026-09-16, al retirar el pedido por chat. Con `services/money.ts`
// fuera, el cálculo del dinero vive ENTERO en este camino: la RPC
// `create_storefront_order` sella el total y `quoteCart` lo cotiza antes. No
// queda una segunda implementación que sirva de contraste, así que estas rutas
// —la cotización, los datos para transferir y el pedido que el cliente
// consulta— pasan a ser el único sitio donde se puede cazar una diferencia.

describe('la cotización del carrito', () => {
  const PRODUCTO = {
    id: 'p1', name: 'Pizza grande', price: 10, price_sale: null,
    active: true, stock: 'disponible',
  }

  beforeEach(() => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ ...NEGOCIO_ABIERTO, delivery_fee: 1.5 })
    vi.spyOn(db, 'getStorefrontProducts').mockResolvedValue([PRODUCTO])
    vi.spyOn(db, 'getStorefrontVariants').mockResolvedValue([])
    vi.spyOn(db, 'getStorefrontOptionGroups').mockResolvedValue([])
    vi.spyOn(db, 'getStorefrontOptions').mockResolvedValue([])
    vi.spyOn(db, 'getBusinessPricingRule').mockResolvedValue(null)
  })
  afterEach(() => vi.restoreAllMocks())

  const cotizar = (body) => ejecutar('/api/store/:slug/quote', 'post', {
    storeBusinessId: 'negocio-a',
    params: { slug: 'pizzeria' },
    body,
  })

  it('un carrito vacío no se cotiza', async () => {
    const respuesta = await cotizar({ items: [] })
    expect(respuesta.status).toBe(400)
    expect(respuesta.body.error).toContain('cotizar')
  })

  it('el precio sale del CATÁLOGO, no de lo que mande el teléfono', async () => {
    // El mismo criterio que al crear el pedido: si un precio del teléfono
    // llegara al total, cualquiera compraría abriendo las herramientas del
    // navegador. Aquí se manda $0.01 y tiene que ganar el catálogo.
    const respuesta = await cotizar({
      items: [{ productId: 'p1', quantity: 2, price: 0.01, unitPrice: 0.01 }],
      fulfillment: 'pickup',
    })

    expect(respuesta.status).toBe(200)
    expect(respuesta.body.subtotal).toBe(20)
    expect(JSON.stringify(respuesta.body)).not.toContain('0.01')
  })

  it('el envío se suma solo cuando hay reparto', async () => {
    const recoge = await cotizar({
      items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup',
    })
    const reparto = await cotizar({
      items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'delivery',
    })

    expect(recoge.body.total).toBe(10)
    expect(reparto.body.total).toBe(11.5)
  })

  it('un producto que no es del negocio no se cotiza', async () => {
    // El catálogo se consulta SIEMPRE por `businessId`, así que un id de otro
    // local simplemente no aparece. Es la frontera multi-tenant vista desde el
    // dinero: cotizar lo ajeno sería el primer paso para comprarlo.
    const respuesta = await cotizar({
      items: [{ productId: 'de-otro-local', quantity: 1 }],
    })
    expect(respuesta.status).toBe(400)
    expect(db.getStorefrontProducts).toHaveBeenCalledWith('negocio-a')
  })

  // Decisión del dueño (2026-10-01): «esconderlo». Hasta ese día viajaban al
  // teléfono el precio del local y el porcentaje de Umbani.
  it('🔒 no lleva el precio del local ni el margen: solo lo que paga el cliente', async () => {
    db.getBusinessPricingRule.mockResolvedValue({ strategy: 'percentage', percentage: 10, mode: 'on_top' })

    const respuesta = await cotizar({
      items: [{ productId: 'p1', quantity: 2 }], fulfillment: 'delivery',
    })

    expect(respuesta.status).toBe(200)
    for (const clave of ['merchantSubtotal', 'platformMarkup', 'markupPercentage', 'customerSubtotal']) {
      expect(respuesta.body).not.toHaveProperty(clave)
    }
    // $10 + 10 % = $11 cada una, como en la carta.
    expect(respuesta.body.lines[0].unitPrice).toBe(11)
    expect(respuesta.body.subtotal).toBe(22)
    expect(respuesta.body.total).toBe(23.5)
  })

  it('un fallo leyendo la regla de margen no tumba la cotización', async () => {
    // Quedarse sin cotizar por un problema NUESTRO deja al cliente sin poder
    // pagar. Sin regla, el precio es el de catálogo: se cobra de menos, nunca
    // de más.
    db.getBusinessPricingRule.mockRejectedValue(new Error('base caída'))

    const respuesta = await cotizar({
      items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup',
    })
    expect(respuesta.status).toBe(200)
    expect(respuesta.body.total).toBe(10)
  })
})

describe('lo que el cliente consulta de su pedido', () => {
  const SESION = {
    businessId: 'negocio-a', customerId: 'cliente-a', contactPhone: '593900000001',
  }
  // Las rutas leen la regla de margen para enseñar cada línea con su precio.
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessPricingRule').mockResolvedValue({ strategy: 'percentage', percentage: 10, mode: 'on_top' })
  })
  afterEach(() => vi.restoreAllMocks())

  it('🔒 el pedido llega con los precios del CLIENTE y sin nada del local ni del margen', async () => {
    // Quien volvía a un pedido pendiente leía «Agua $0,75» cuando pagó $0,83,
    // y las líneas no sumaban el total (2026-10-01).
    vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({
      data: {
        id: 'o1', total: 2.43, shipping: 1.5, service_fee: 0.1,
        merchant_subtotal: 0.75, platform_markup: 0.18,
        order_items: [{ product_name: 'Agua', quantity: 1, line_total: 0.75 }],
      },
      error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: SESION, params: { slug: 'pizzeria', id: 'o1' },
    })

    expect(respuesta.status).toBe(200)
    expect(respuesta.body.order_items[0].line_total).toBe(0.83)
    expect(respuesta.body.subtotal).toBe(0.83)
    expect(respuesta.body.service_fee).toBe(0.1)
    expect(respuesta.body).not.toHaveProperty('merchant_subtotal')
    expect(respuesta.body).not.toHaveProperty('platform_markup')
  })

  it('la lista de pedidos se pide por negocio Y por teléfono', async () => {
    // Las dos claves juntas, siempre: solo con `businessId` un cliente vería
    // los pedidos de todos los demás del mismo local.
    const consulta = vi.spyOn(db, 'getStorefrontOrders')
      .mockResolvedValue({ data: [{ id: 'o1', order_items: [] }], error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(200)
    expect(consulta).toHaveBeenCalledWith({
      businessId: 'negocio-a', contactPhone: '593900000001',
    })
  })

  it('un fallo de la base no devuelve una lista vacía, que parecería «no tienes pedidos»', async () => {
    vi.spyOn(db, 'getStorefrontOrders').mockResolvedValue({ data: null, error: { message: 'x' } })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })
    expect(respuesta.status).toBe(500)
  })

  it('un pedido ajeno responde 404, no el pedido', async () => {
    // La consulta lleva las tres claves; si no casan, no hay fila. Se comprueba
    // que el 404 sale de ahí y no de un `if` que alguien pueda quitar.
    const consulta = vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({ data: null, error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: SESION, params: { slug: 'pizzeria', id: 'de-otro' },
    })

    expect(respuesta.status).toBe(404)
    expect(consulta).toHaveBeenCalledWith({
      businessId: 'negocio-a', contactPhone: '593900000001', orderId: 'de-otro',
    })
  })

  it('los datos para transferir son SOLO los del propio negocio', async () => {
    const cuenta = vi.spyOn(db, 'getBusinessBankAccount')
      .mockResolvedValue({ bank: 'Pichincha', number: '2100xxxx' })

    const respuesta = await ejecutar('/api/store/:slug/payment-info', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })

    expect(respuesta.status).toBe(200)
    expect(cuenta).toHaveBeenCalledWith('negocio-a')
  })

  it('sin datos de pago cargados se dice, no se inventa una cuenta', async () => {
    vi.spyOn(db, 'getBusinessBankAccount').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/payment-info', 'get', {
      storefront: SESION, params: { slug: 'pizzeria' },
    })
    expect(respuesta.status).toBe(404)
  })
})
