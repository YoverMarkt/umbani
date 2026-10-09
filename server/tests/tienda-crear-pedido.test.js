import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEGOCIO_ABIERTO, db, ejecutar } from './manejadores-de-la-tienda.mjs'

// ── Comportamiento de los manejadores ──────────────────────────────────────
//
// Lo de arriba comprueba el CABLEADO: qué rutas existen y qué middleware
// llevan. Nada de eso ejecuta un manejador, y por eso la cobertura de este
// archivo estaba en 21%: nadie había hecho nunca un pedido por aquí.
//
// Es el camino que usa el cliente final desde su teléfono, así que estas
// pruebas van a lo que no se puede fallar: que el precio lo ponga el servidor
// y que un negocio no vea lo de otro.

const AVISOS_ANTES = process.env.AVISOS_WHATSAPP_AL_CLIENTE

describe('crear pedido desde la mini app', () => {
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(NEGOCIO_ABIERTO)
    vi.spyOn(db, 'getSchedule').mockResolvedValue([])
    // Sin esto la ruta consulta la base de verdad y la prueba se cuelga cinco
    // segundos: crear un pedido comprueba antes que el cliente no esté
    // bloqueado.
    vi.spyOn(db, 'isCustomerBlocked').mockResolvedValue(false)
    // Y lo mismo al terminar: la ruta relee la fila para devolver el total
    // SELLADO (con el margen que suma el disparador) en vez del que calculó la
    // RPC. Por defecto se devuelve `null`, que es el camino de «no se pudo
    // releer»: cada prueba que le importe el dinero lo espía a su manera.
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue(null)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    // Alguna prueba enciende el aviso dormido: se devuelve aunque falle a mitad.
    if (AVISOS_ANTES === undefined) delete process.env.AVISOS_WHATSAPP_AL_CLIENTE
    else process.env.AVISOS_WHATSAPP_AL_CLIENTE = AVISOS_ANTES
  })

  // Regla inviolable #8: la IA conversa, el CÓDIGO calcula. Aquí ni siquiera
  // hay IA — hay un teléfono, que es aún menos de fiar. Si un precio enviado
  // desde la app llegara a la base, cualquiera compraría una pizza a $0.01
  // abriendo las herramientas del navegador.
  // ⚠️ El bloqueo del dueño es TOTAL: si solo callara al bot, quien tenga su
  // enlace guardado seguiría metiendo pedidos y el bloqueo no bloquearía nada.
  it('un cliente bloqueado no puede pedir, ni con su enlace', async () => {
    vi.spyOn(db, 'isCustomerBlocked').mockResolvedValue(true)
    const crear = vi.spyOn(db, 'createStorefrontOrder')

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-a', contactPhone: '593900000001' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup' },
    })

    expect(respuesta.status).toBe(403)
    // Ni se intenta: el pedido no llega a la base.
    expect(crear).not.toHaveBeenCalled()
    // Y no se le dice «estás bloqueado»: quien molesta busca una reacción.
    expect(respuesta.body.error).not.toMatch(/bloquead/i)
  })

  // ── EL TOTAL QUE VE EL CLIENTE ES EL DE LA FILA ─────────────────────────
  //
  // ⚠️ `create_storefront_order` devuelve SU cuenta —`subtotal + envío`— y el
  // disparador `orders_stamp_pricing` corre después: en modo `on_top` suma el
  // margen de la plataforma al total. La ruta devolvía lo primero, así que la
  // app enseñaba $12.99 sobre un pedido que la base guardaba en $14.09 — y ese
  // es justo el número que el cliente copia para transferir. Siete pedidos
  // reales nacieron con esa diferencia de $1.10.
  //
  // Estas dos pruebas existen para que los dos números no se puedan volver a
  // separar sin que alguien se entere.
  it('devuelve el total SELLADO en la fila, no el que calculó la RPC', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      // Lo que la RPC calcula: subtotal + envío, sin el margen.
      data: { id: 'pedido-1', subtotal: 10.99, shipping: 2, total: 12.99, items: 1 },
      error: null,
    })
    // Lo que el disparador dejó escrito de verdad.
    const leer = vi.spyOn(db, 'getOrderMoney').mockResolvedValue({
      subtotal: 10.99, shipping: 2, total: 14.09,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(leer).toHaveBeenCalledWith('negocio-a', 'pedido-1')
    // El total del cliente es el de la fila, con el margen incluido.
    expect(Number(respuesta.body.total)).toBe(14.09)
    // Y NO el que devolvió la RPC.
    expect(Number(respuesta.body.total)).not.toBe(12.99)
    // El identificador no se pierde por el camino.
    expect(respuesta.body.id).toBe('pedido-1')
  })

  it('si no se puede releer la fila, el pedido igual se confirma', async () => {
    // El pedido YA está creado. Dejar al cliente sin confirmación por no poder
    // releer un total sería peor que devolver el que se tiene.
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-2', subtotal: 10, shipping: 0, total: 10 }, error: null,
    })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(respuesta.body.id).toBe('pedido-2')
  })

  // ── EL AVISO «MÁNDANOS LA FOTO» SALE DE VERDAD ──────────────────────────
  //
  // ⚠️ No salió NI UNA VEZ en un mes (#283 → 2026-09-27: 0 en la cola de
  // producción). La ruta preguntaba por `result.data.status`, y
  // `create_storefront_order` NO devuelve `status`: la condición era siempre
  // falsa. La prueba del aviso pasaba porque llamaba a la función SUELTA con
  // un pedido inventado que sí traía el campo — nadie comprobaba que la ruta
  // llegara a llamarla.
  //
  // Por eso aquí la RPC devuelve su forma REAL (sin `status`), y lo que se
  // mira es que el aviso llegue a reclamar el pedido.
  it('pide el comprobante por el chat cuando la FILA espera pago (con el aviso encendido)', async () => {
    // El aviso está APAGADO desde el 2026-10-09: aquí se prueba DORMIDO.
    process.env.AVISOS_WHATSAPP_AL_CLIENTE = 'si'
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-3', order_number: 7, subtotal: 10, shipping: 0, total: 10, items: 1 },
      error: null,
    })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue({
      subtotal: 10, shipping: 0, total: 10, status: 'esperando_pago',
    })
    const reclamo = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }], paymentMethod: 'transferencia' },
    })

    expect(respuesta.status).toBe(201)
    expect(reclamo).toHaveBeenCalledWith('negocio-a', 'pedido-3', 'esperando_pago')
  })

  it('por defecto NO lo pide por el chat: el comprobante se sube en la app (Umbani es solo app)', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-5', order_number: 9, subtotal: 10, shipping: 0, total: 10, items: 1 },
      error: null,
    })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue({
      subtotal: 10, shipping: 0, total: 10, status: 'esperando_pago',
    })
    const reclamo = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }], paymentMethod: 'transferencia' },
    })

    expect(respuesta.status).toBe(201)
    expect(reclamo).not.toHaveBeenCalled()
  })

  it('no se lo pide a un pedido en efectivo', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-4', order_number: 8, subtotal: 10, shipping: 0, total: 10, items: 1 },
      error: null,
    })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue({
      subtotal: 10, shipping: 0, total: 10, status: 'pendiente',
    })
    const reclamo = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }], paymentMethod: 'efectivo' },
    })

    expect(respuesta.status).toBe(201)
    expect(reclamo).not.toHaveBeenCalled()
  })

  it('descarta cualquier precio que mande el teléfono', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1', total: 1250 }, error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        items: [{
          productId: 'producto-1', quantity: 2,
          price: 1, unit_price: 1, total: 1, precio: 1,
          // Las opciones son la puerta nueva por la que podría colarse un
          // importe: llevan su propio recargo en el catálogo.
          options: [{ optionId: 'opcion-1', quantity: 3, price: 0.01, recargo: -99 }],
        }],
      },
    })

    expect(respuesta.status).toBe(201)
    const enviado = crear.mock.calls[0][0]
    // Del ítem solo sobreviven identificadores y cantidades.
    expect(enviado.items).toEqual([{
      product_id: 'producto-1',
      variant_id: null,
      extra_ids: [],
      options: [{ option_id: 'opcion-1', quantity: 3 }],
      quantity: 2,
      note: null,
    }])
    expect(JSON.stringify(enviado)).not.toContain('price')
    expect(JSON.stringify(enviado)).not.toContain('precio')
    expect(JSON.stringify(enviado)).not.toContain('recargo')
  })

  // Un doble toque en «Confirmar» creaba dos comandas en la cocina y un
  // cliente pagando dos veces. La app manda una clave por carrito; la base
  // devuelve el mismo pedido si ya existe uno con ella.
  it('pasa la clave del pedido tal cual, para que no se dupliquen', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        idempotencyKey: 'clave-del-carrito',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })

    expect(crear.mock.calls[0][0].idempotencyKey).toBe('clave-del-carrito')
  })

  // Elegir «entrega» o «retiro» pasó a hacerse también en la portada de la
  // tienda, no solo en el carrito. Lo que llegue aquí decide si el pedido sale
  // con dirección y si se cobra envío, así que se comprueba que viaja entero
  // hasta la base y que un valor inventado no se cuela.
  it('el modo de entrega elegido viaja hasta la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    for (const modo of ['delivery', 'pickup', 'onsite']) {
      crear.mockClear()
      await ejecutar('/api/store/:slug/orders', 'post', {
        storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
        params: { slug: 'pizzeria' },
        body: { fulfillment: modo, items: [{ productId: 'producto-1', quantity: 1 }] },
      })
      expect(crear.mock.calls[0][0].fulfillment).toBe(modo)
    }
  })

  it('un modo de entrega inventado no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    // Nulo, no el texto tal cual: la base decide entonces su propio defecto en
    // vez de guardar «gratis_para_mi» en la columna del modo de entrega.
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { fulfillment: 'gratis_para_mi', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].fulfillment).toBeNull()
  })

  // ── Seguimiento del pedido ─────────────────────────────────────────────
  //
  // Aquí se devuelve el pedido de UNA persona, con su número y su estado. La
  // sesión no basta por sí sola: hay que atarlo al TELÉFONO de esa sesión, o
  // cualquiera con un enlace válido de esta tienda leería pedidos ajenos
  // probando identificadores.
  it('el seguimiento filtra por el teléfono de la sesión, no solo por el pedido', async () => {
    const consultar = vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1', order_number: 8, status: 'preparacion', events: [] }, error: null,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria', id: 'pedido-1' },
    })

    expect(respuesta.status).toBe(200)
    expect(consultar).toHaveBeenCalledWith({
      businessId: 'negocio-a',
      contactPhone: '+593999',
      orderId: 'pedido-1',
    })
  })

  // Un pedido ajeno y uno inexistente responden IGUAL. Si se distinguieran,
  // se podría averiguar qué pedidos tiene el vecino probando identificadores.
  it('un pedido que no es suyo responde 404, como uno que no existe', async () => {
    vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({ data: null, error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders/:id', 'get', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria', id: 'pedido-de-otro' },
    })

    expect(respuesta.status).toBe(404)
    expect(respuesta.body.error).toMatch(/No encontramos/)
  })

  // ── El método de pago y las instrucciones ──────────────────────────────

  it('«pago al retirar» no se acepta en un pedido a domicilio', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    // En retiro sí: es cuando de verdad se puede cumplir.
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        fulfillment: 'pickup', paymentMethod: 'pago_al_retirar',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].paymentMethod).toBe('pago_al_retirar')

    // A domicilio no: prometerle al negocio que alguien pasará a recoger un
    // pedido que va a llevarle el repartidor es prometer lo que no ocurrirá.
    crear.mockClear()
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        fulfillment: 'delivery', paymentMethod: 'pago_al_retirar',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].paymentMethod).toBeNull()
  })

  it('las instrucciones del cliente viajan, recortadas al tope de la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        deliveryNotes: '  Llame al llegar, timbre roto  ',
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].deliveryNotes).toBe('Llame al llegar, timbre roto')

    // El CHECK de la base corta en 300: recortar aquí evita que un texto largo
    // reviente el pedido entero en vez de perder solo la cola del mensaje.
    crear.mockClear()
    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: {
        deliveryNotes: 'x'.repeat(500),
        items: [{ productId: 'producto-1', quantity: 1 }],
      },
    })
    expect(crear.mock.calls[0][0].deliveryNotes).toHaveLength(300)
  })

  // ── El nombre se escribe UNA vez ─────────────────────────────────────────
  //
  // La mini app ya precargaba `me.name` en el checkout, pero nadie escribía
  // nunca `business_customers.display_name`: `ensureCustomer` lo intenta con
  // un `upsert` que la fila existente ignora —la crea el bot al mandar el
  // enlace, sin nombre—, y en ese momento el nombre todavía no existe. En la
  // base real: 25 pedidos del mismo cliente y `display_name` en nulo.
  it('recuerda el nombre del cliente para el próximo pedido', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { name: '  Yover Rosado  ', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(recordar).toHaveBeenCalledWith('negocio-a', 'cliente-1', 'Yover Rosado')
  })

  it('no guarda un nombre que no lo es', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    for (const name of ['', '   ', 'A']) {
      await ejecutar('/api/store/:slug/orders', 'post', {
        storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
        params: { slug: 'pizzeria' },
        body: { name, items: [{ productId: 'producto-1', quantity: 1 }] },
      })
    }

    expect(recordar).not.toHaveBeenCalled()
  })

  // Recordar el nombre es una comodidad. El pedido ya está creado y aceptado
  // por la base cuando se intenta: que esto falle no puede quitárselo al
  // cliente ni devolverle un error por algo que sí funcionó.
  it('un fallo al recordar el nombre no rompe el pedido', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    vi.spyOn(db, 'setCustomerDisplayName').mockRejectedValue(new Error('base caída'))

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { name: 'Yover', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(201)
    expect(respuesta.body).toEqual({ id: 'pedido-1' })
  })

  // El nombre pertenece al negocio de la SESIÓN, igual que el pedido. Si
  // saliera del slug, se escribiría en la ficha del cliente en otra tienda.
  it('recuerda el nombre en el negocio de la sesión, no en el del slug', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })
    const recordar = vi.spyOn(db, 'setCustomerDisplayName').mockResolvedValue({ error: null })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'otra-tienda' },
      body: { name: 'Yover', items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(recordar.mock.calls[0][0]).toBe('negocio-a')
  })

  it('sin clave se sigue creando un pedido por envío, como el bot', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].idempotencyKey).toBeNull()
  })

  // El negocio sale de la SESIÓN, nunca del slug de la dirección. Si saliera
  // del slug, cambiar una palabra en la barra bastaría para pedir en otra
  // tienda con la sesión propia.
  it('usa el negocio de la sesión y no el slug de la dirección', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1' }, error: null,
    })

    await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'otra-tienda' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(crear.mock.calls[0][0].businessId).toBe('negocio-a')
  })

  // 42501 lo lanza la RPC cuando el producto es de otro negocio. Devolver 500
  // lo haría parecer un fallo nuestro y escondería un intento de cruzar la
  // frontera entre negocios.
  it('traduce el rechazo por pertenencia a 403, no a error del servidor', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: null, error: { code: '42501', message: 'producto ajeno' },
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-de-otro', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(403)
  })

  it('rechaza un pedido sin productos antes de tocar la base', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder')

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [] },
    })

    expect(respuesta.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  // El horario del dueño manda también aquí, no solo en el bot.
  //
  // ⚠️ La hora se FIJA. Antes el horario de prueba era 00:00–00:01 todos los
  // días, así que el test fallaba si se corría dentro de ese minuto — y pasó,
  // justo a las 00:00. Un test que depende del reloj real es una alarma que
  // suena sola una vez al día.
  it('no acepta pedidos con el negocio cerrado', async () => {
    // Un lunes a las 22:00 de Ecuador, con el local cerrado desde las 18:00.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T03:00:00Z'))

    const crear = vi.spyOn(db, 'createStorefrontOrder')
    vi.spyOn(db, 'getSchedule').mockResolvedValue(
      [1, 2, 3, 4, 5].map(day => ({
        day_of_week: day, open_time: '09:00', close_time: '18:00', is_active: true,
      })),
    )

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(409)
    expect(crear).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  // Un negocio SUSPENDIDO no recibe pedidos: `cerrada` es temporal y puede
  // abrir en una hora; `suspendida` significa que esta tienda no vende.
  it('un negocio suspendido no acepta pedidos', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder')
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({
      id: 'negocio-a', active: true, suspended: true,
      storefront_enabled: true, takes_orders: true,
    })

    const respuesta = await ejecutar('/api/store/:slug/orders', 'post', {
      storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '+593999' },
      params: { slug: 'pizzeria' },
      body: { items: [{ productId: 'producto-1', quantity: 1 }] },
    })

    expect(respuesta.status).toBe(409)
    expect(crear).not.toHaveBeenCalled()
  })
})
