import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import ordersRouter from '../dist/routes/orders.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const cloud = require('../dist/integrations/cloudinary')
const JWT_SECRET = 'orders-route-test-secret'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function token(claims) {
  return jwt.sign(claims, JWT_SECRET)
}

async function dispatch({ authorization, query = {} } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders' && layer.route?.methods?.get
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: authorization ? { authorization } : {}, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

async function dispatchAnalisis({ authorization, id = 'order-a' } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders/:id/receipt-analysis'
    && layer.route?.methods?.get
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: authorization ? { authorization } : {}, params: { id }, query: {} }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }
  await run(0)
  return result
}

async function dispatchConfirmarPago({ authorization, id = 'order-a' } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders/:id/payment-confirmed'
    && layer.route?.methods?.put
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: authorization ? { authorization } : {}, params: { id }, body: {} }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

async function dispatchStatus({ authorization, status, id = 'order-a' } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders/:id/status' && layer.route?.methods?.put
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = {
    headers: authorization ? { authorization } : {},
    body: { status },
    params: { id },
  }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

describe('GET /api/client/orders', () => {
  it('rechaza solicitudes sin token', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])

    const response = await dispatch()

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'No autorizado' })
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('usa únicamente el businessId del JWT del dueño', async () => {
    const orders = [{ id: 'order-a', business_id: 'business-a', total: 10 }]
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue(orders)
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({
      authorization,
      query: { businessId: 'business-b' },
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual(orders)
    expect(getOrders).toHaveBeenCalledOnce()
    expect(getOrders).toHaveBeenCalledWith('business-a', 100, null)
  })

  it('filtra por estado cuando el panel vigila los pendientes', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({ authorization, query: { status: 'pendiente' } })

    expect(response.status).toBe(200)
    expect(getOrders).toHaveBeenCalledWith('business-a', 100, 'pendiente')
  })

  it('acepta filtrar por los estados de reparto', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    for (const status of ['preparacion', 'en_camino']) {
      const response = await dispatch({ authorization, query: { status } })
      expect(response.status).toBe(200)
      expect(getOrders).toHaveBeenCalledWith('business-a', 100, status)
    }
  })

  // ── La consulta que alimenta la alarma ────────────────────────────────────
  //
  // Lo que espera al negocio son DOS estados: un pedido nuevo y un comprobante
  // por revisar. Mientras esto aceptó uno solo, la alarma vigilaba «pendiente»
  // y no sonaba con ningún pedido pagado por transferencia — que desde el
  // 2026-08-08 nacen en `esperando_pago` y pasan a `pago_en_revision`.
  it('acepta varios estados separados por comas', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({
      authorization,
      query: { status: 'pendiente,pago_en_revision' },
    })

    expect(response.status).toBe(200)
    expect(getOrders).toHaveBeenCalledWith('business-a', 100, ['pendiente', 'pago_en_revision'])
  })

  it('rechaza la lista entera si uno de los estados no existe', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({
      authorization,
      query: { status: 'pendiente,inventado' },
    })

    expect(response.status).toBe(400)
    // Ni siquiera se consulta lo válido: una lista a medias devolvería datos
    // incompletos que el panel daría por completos.
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('no repite un estado que venga varias veces', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({
      authorization,
      query: { status: 'pendiente,pendiente,pago_en_revision,pendiente' },
    })

    expect(response.status).toBe(200)
    expect(getOrders).toHaveBeenCalledWith('business-a', 100, ['pendiente', 'pago_en_revision'])
  })

  it('rechaza una lista vacía en vez de traerlo todo', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    // `?status=,` pidió filtrar y no nombró ninguno. Colarlo como «sin filtro»
    // devolvería los 100 pedidos del negocio a la vigilancia que corre cada
    // doce segundos.
    const response = await dispatch({ authorization, query: { status: ',' } })

    expect(response.status).toBe(400)
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('rechaza un estado desconocido en vez de consultarlo', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'owner',
    })}`

    const response = await dispatch({ authorization, query: { status: 'inventado' } })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'Estado de pedido inválido' })
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('rechaza empleados sin permiso de ventas', async () => {
    const getOrders = vi.spyOn(db, 'getOrders').mockResolvedValue([])
    const authorization = `Bearer ${token({
      role: 'client',
      businessId: 'business-a',
      urole: 'employee',
      perms: ['citas'],
    })}`

    const response = await dispatch({ authorization })

    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'No tienes permiso para esta sección' })
    expect(getOrders).not.toHaveBeenCalled()
  })
})

describe('POST /api/client/orders (mostrador)', () => {
  async function dispatchCrear({ authorization, body = {} } = {}) {
    const capa = ordersRouter.stack.find(layer => (
      layer.route?.path === '/api/client/orders' && layer.route?.methods?.post
    ))
    const handlers = capa.route.stack.map(layer => layer.handle)
    const req = { headers: authorization ? { authorization } : {}, body, query: {} }
    const result = { status: 200, body: undefined }
    const res = {
      status(code) { result.status = code; return this },
      json(payload) { result.body = payload; return this },
    }
    async function run(index) {
      if (index >= handlers.length) return
      let next = false
      let fallo
      await handlers[index](req, res, error => { next = true; fallo = error })
      if (fallo) throw fallo
      if (next) await run(index + 1)
    }
    await run(0)
    return result
  }

  it('rechaza a quien no tiene permiso de ventas', async () => {
    const createOrder = vi.spyOn(db, 'createOrder')
    const authorization = `Bearer ${token({
      role: 'client', businessId: 'business-a', urole: 'employee', perms: ['citas'],
    })}`

    const response = await dispatchCrear({ authorization, body: { items: [{ product_id: 'p', quantity: 1 }] } })

    expect(response.status).toBe(403)
    expect(createOrder).not.toHaveBeenCalled()
  })

  // Nace entregado y con el negocio del JWT: nunca uno del cuerpo.
  it('crea el pedido ya entregado, con el negocio del token', async () => {
    const createOrder = vi.spyOn(db, 'createOrder').mockResolvedValue({
      data: { id: 'order-nuevo', total: 12.5 }, error: null,
    })
    const authorization = `Bearer ${token({
      role: 'client', businessId: 'business-a', urole: 'owner',
    })}`

    const response = await dispatchCrear({
      authorization,
      body: { business_id: 'business-b', items: [{ product_id: 'prod-1', quantity: 2 }] },
    })

    expect(response.status).toBe(201)
    const [pedido, lineas] = createOrder.mock.calls[0]
    expect(pedido.business_id).toBe('business-a')
    expect(pedido.status).toBe('completado')
    expect(pedido.source).toBe('manual')
    expect(pedido.contact_phone).toBe('mostrador')
    expect(lineas).toEqual([{ product_id: 'prod-1', quantity: 2 }])
  })

  // El precio JAMÁS viaja desde el navegador: solo ids y cantidades.
  it('descarta cualquier precio que mande el panel', async () => {
    const createOrder = vi.spyOn(db, 'createOrder').mockResolvedValue({
      data: { id: 'order-nuevo' }, error: null,
    })
    const authorization = `Bearer ${token({
      role: 'client', businessId: 'business-a', urole: 'owner',
    })}`

    await dispatchCrear({
      authorization,
      body: { items: [{ product_id: 'prod-1', quantity: 1, unit_price: 0.01, line_total: 0.01 }] },
    })

    expect(createOrder.mock.calls[0][1]).toEqual([{ product_id: 'prod-1', quantity: 1 }])
  })

  it('rechaza un pedido sin productos', async () => {
    const createOrder = vi.spyOn(db, 'createOrder')
    const authorization = `Bearer ${token({
      role: 'client', businessId: 'business-a', urole: 'owner',
    })}`

    const response = await dispatchCrear({ authorization, body: { items: [] } })

    expect(response.status).toBe(400)
    expect(createOrder).not.toHaveBeenCalled()
  })
})

// ── «Ya me llegó el pago» ───────────────────────────────────────────────────
//
// El botón para la transferencia que no pasó por la app: el cliente pagó desde
// su banco —a veces desde la cuenta de un familiar— y mandó la captura por
// WhatsApp. Sin esto, el cliente seguía viendo el número de cuenta y el dueño
// «sin comprobante todavía» sobre un pedido ya cobrado.
describe('PUT /api/client/orders/:id/payment-confirmed', () => {
  const authorization = () => `Bearer ${token({
    role: 'client', businessId: 'business-a', urole: 'owner',
  })}`

  it('marca el pago con el negocio del JWT, nunca con uno del request', async () => {
    const confirmar = vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue({
      id: 'order-a', status: 'esperando_pago', payment_confirmed_at: '2026-08-08T05:00:00.000Z',
    })

    const response = await dispatchConfirmarPago({ authorization: authorization() })

    expect(response.status).toBe(200)
    expect(confirmar).toHaveBeenCalledWith('business-a', 'order-a')
  })

  // La consulta filtra por negocio, método y estado en su propio `where`, así
  // que un `null` significa «no cumplía». No se dice cuál de las condiciones
  // falló: distinguirlas confirmaría qué pedidos existen en otros negocios.
  it('responde 409 sin explicar por qué cuando el pedido no cumple', async () => {
    vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)

    const response = await dispatchConfirmarPago({ authorization: authorization() })

    expect(response.status).toBe(409)
    expect(JSON.stringify(response.body)).not.toMatch(/efectivo|otro negocio|cancelado/i)
  })

  it('no deja confirmar pagos a un empleado sin permiso de ventas', async () => {
    const confirmar = vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)
    const sinPermiso = `Bearer ${token({
      role: 'client', businessId: 'business-a', urole: 'employee', perms: ['citas'],
    })}`

    const response = await dispatchConfirmarPago({ authorization: sinPermiso })

    expect(response.status).toBe(403)
    expect(confirmar).not.toHaveBeenCalled()
  })

  it('no deja confirmar pagos sin sesión', async () => {
    const confirmar = vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)

    const response = await dispatchConfirmarPago({})

    expect(response.status).toBe(401)
    expect(confirmar).not.toHaveBeenCalled()
  })
})

describe('PUT /api/client/orders/:id/status', () => {
  const authorization = () => `Bearer ${token({
    role: 'client', businessId: 'business-a', urole: 'owner',
  })}`

  // El aviso al cliente sale por un canal externo. Sin acallarlo, cada prueba
  // que acepta un pedido intentaría hablar con Supabase y con YCloud de
  // verdad: la primera vez se quedaron cinco segundos colgadas esperando un
  // `fetch` que nadie iba a contestar.
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'business-a', name: 'Negocio' })
    vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)
  })

  // Aceptar el pedido ES dar el pago por bueno: el dueño que manda algo a la
  // cocina ya decidió que le van a pagar. Sin esta marca, el cliente que
  // transfirió seguiría viendo el número de cuenta con su pedido en marcha.
  it('aceptar y preparar marca también el pago', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })
    const confirmar = vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)

    const response = await dispatchStatus({
      authorization: authorization(), status: 'preparacion',
    })

    expect(response.status).toBe(200)
    expect(confirmar).toHaveBeenCalledWith('business-a', 'order-a')
  })

  // ── Un aviso por pedido, y solo uno ──────────────────────────────────────
  //
  // `set_order_status` responde `updated` TAMBIÉN cuando el estado ya era ese
  // —pedir un cambio que ya ocurrió no es un error—, así que desde fuera un
  // segundo toque en «Aceptar y preparar» es indistinguible del primero. El
  // reclamo atómico es lo único que impide el segundo mensaje, y desde el 1 de
  // octubre de 2026 Meta cobra cada uno.
  it('reclama el aviso POR HITO antes de mandarlo', async () => {
    vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)
    const reclamar = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    // Los cuatro hitos que se le cuentan al cliente. El reclamo lleva el
    // estado: con uno solo, el primer aviso dejaba la marca puesta y los
    // demás no saldrían nunca — un fallo que no rompe nada, solo deja de
    // hacer algo.
    for (const status of ['preparacion', 'en_camino', 'listo_para_retiro', 'completado']) {
      vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
        data: { result: 'updated', order: { id: 'order-a', status } },
        error: null,
      })
      await dispatchStatus({ authorization: authorization(), status })
      expect(reclamar, status).toHaveBeenCalledWith('business-a', 'order-a', status)
    }
  })

  // Cada hito es un mensaje que se paga. Los estados intermedios no le dicen
  // al cliente nada que no sepa: pagar por contárselos sería pagar por ruido.
  // ⚠️ `cancelado` y `rechazado` SALIERON de esta lista el 2026-08-13: desde
  // entonces sí avisan, porque dejan al cliente esperando algo que no llega.
  // Los que quedan son los que no le dicen nada que no sepa.
  it('los estados intermedios no gastan un mensaje', async () => {
    vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)
    const reclamar = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    for (const status of ['confirmado', 'aceptado']) {
      vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
        data: { result: 'updated', order: { id: 'order-a', status } },
        error: null,
      })
      await dispatchStatus({ authorization: authorization(), status })
    }

    expect(reclamar).not.toHaveBeenCalled()
  })

  it('cancelar SÍ avisa: el cliente está esperando algo que no va a llegar', async () => {
    vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)
    const reclamar = vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)

    for (const status of ['cancelado', 'rechazado']) {
      vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
        data: { result: 'updated', order: { id: 'order-a', status } },
        error: null,
      })
      await dispatchStatus({ authorization: authorization(), status })
    }

    // Se reclama por HITO, así que los dos pasan por aquí: un pedido no puede
    // ser cancelado y rechazado a la vez, pero el reclamo es lo que impide que
    // un doble toque mande —y cobre— dos veces el mismo aviso.
    expect(reclamar).toHaveBeenCalledTimes(2)
  })

  it('si el reclamo lo perdió, no redacta ni envía nada', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })
    vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)
    // `null` = a este cliente ya se le avisó.
    vi.spyOn(db, 'claimOrderNotification').mockResolvedValue(null)
    const negocio = vi.spyOn(db, 'getBusinessById')

    await dispatchStatus({ authorization: authorization(), status: 'preparacion' })

    // Ni siquiera se lee el negocio: sin reclamo no hay nada que redactar.
    expect(negocio).not.toHaveBeenCalled()
  })

  it('los demás pasos no tocan el pago', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'en_camino' } },
      error: null,
    })
    const confirmar = vi.spyOn(db, 'confirmOrderPayment').mockResolvedValue(null)

    await dispatchStatus({ authorization: authorization(), status: 'en_camino' })

    expect(confirmar).not.toHaveBeenCalled()
  })

  // El estado ya cambió cuando se intenta marcar el pago: la cocina tiene su
  // pedido. Devolver un error ahí le diría al dueño que no pasó algo que sí
  // pasó, y volvería a tocar el botón sobre un pedido ya en marcha.
  it('un fallo al marcar el pago no rompe el cambio de estado', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })
    vi.spyOn(db, 'confirmOrderPayment').mockRejectedValue(new Error('base caída'))

    const response = await dispatchStatus({
      authorization: authorization(), status: 'preparacion',
    })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: 'order-a', status: 'preparacion' })
  })

  it('usa la RPC atómica con el negocio del JWT', async () => {
    const setOrderStatus = vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'completado' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'completado' })

    expect(response).toEqual({
      status: 200, body: { id: 'order-a', status: 'completado' },
    })
    expect(setOrderStatus).toHaveBeenCalledWith('business-a', 'order-a', 'completado')
  })

  it('rechaza estados desconocidos antes de tocar la base', async () => {
    const setOrderStatus = vi.spyOn(db, 'setOrderStatus')

    const response = await dispatchStatus({ authorization: authorization(), status: 'pagado' })

    expect(response.status).toBe(400)
    expect(setOrderStatus).not.toHaveBeenCalled()
  })

  it('devuelve conflicto cuando el pedido ya está en un estado final', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'invalid_transition', order: { id: 'order-a', status: 'cancelado' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'confirmado' })

    expect(response.status).toBe(409)
  })

  it('acepta los estados de reparto', async () => {
    const setOrderStatus = vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'updated', order: { id: 'order-a', status: 'en_camino' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'en_camino' })

    expect(response.status).toBe(200)
    expect(setOrderStatus).toHaveBeenCalledWith('business-a', 'order-a', 'en_camino')
  })

  // Un pedido para retirar en el local no sale a reparto: lo decide la base y
  // el dueño tiene que entender POR QUÉ, no un conflicto genérico.
  it('explica que un pedido de retiro no puede salir a reparto', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'not_deliverable', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'en_camino' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'Este pedido es para retirar en el local: no puede salir a reparto',
    })
  })

  // El candado de la checklist (#407) respondía bien en la base y la ruta lo
  // convertía en un 500 «respuesta inválida». Lo cazaron los recorridos.
  it('dice qué falta meter en la bolsa en vez de un 500', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'incompleto', faltan: 'Agua sin gas x2, Brownie x1', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'en_camino' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({
      error: 'Todavía falta meter en la bolsa: Agua sin gas x2, Brownie x1',
      faltan: 'Agua sin gas x2, Brownie x1',
    })
  })

  it('el cobro con tarjeta sin confirmar es una regla (409 con su motivo), no un fallo', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Este pedido se paga con tarjeta y el cobro aún no está confirmado.' },
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'aceptado' })

    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'Este pedido se paga con tarjeta y el cobro aún no está confirmado.' })
  })

  it('un fallo de verdad de la base sigue siendo 500', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'aceptado' })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'No se pudo actualizar el pedido' })
  })

  it('un pedido a domicilio no se marca «listo para retirar»: conflicto, no 500', async () => {
    vi.spyOn(db, 'setOrderStatus').mockResolvedValue({
      data: { result: 'not_pickable', order: { id: 'order-a', status: 'preparacion' } },
      error: null,
    })

    const response = await dispatchStatus({ authorization: authorization(), status: 'listo_para_retiro' })

    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/a domicilio/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL COMPROBANTE DE UNA TRANSFERENCIA
// ═══════════════════════════════════════════════════════════════════════════
//
// Es el movimiento bancario de un cliente real, con su nombre y su cuenta.
// Hasta hoy vivía en una URL pública y permanente de Cloudinary: quien la
// adivinara —o la recibiera reenviada— lo veía. Ahora se firma un acceso
// temporal y solo para el dueño del negocio al que pertenece el pedido.

async function pedirComprobante({ authorization, id = 'pedido-1' } = {}) {
  const routeLayer = ordersRouter.stack.find(layer => (
    layer.route?.path === '/api/client/orders/:id/proof' && layer.route?.methods?.get
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: authorization ? { authorization } : {}, params: { id }, query: {} }
  const salida = { status: 200, body: undefined }
  const res = {
    status(code) { salida.status = code; return this },
    json(cuerpo) { salida.body = cuerpo; return this },
  }
  for (const handler of handlers) {
    let siguio = false
    await handler(req, res, (error) => { if (error) throw error; siguio = true })
    if (!siguio) break
  }
  return salida
}

describe('ver el comprobante', () => {
  const cliente = () => `Bearer ${token({
    role: 'client', businessId: 'negocio-a', urole: 'owner',
  })}`

  it('el pedido se busca por NEGOCIO e id, nunca solo por id', async () => {
    const buscar = vi.spyOn(db, 'getOrderProof').mockResolvedValue(null)

    const r = await pedirComprobante({ authorization: cliente(), id: 'de-otro-local' })

    expect(r.status).toBe(404)
    // Sin el negocio se estaría dando el comprobante de otro local.
    expect(buscar).toHaveBeenCalledWith('negocio-a', 'de-otro-local')
  })

  it('un pedido sin comprobante da 404, no una URL vacía', async () => {
    vi.spyOn(db, 'getOrderProof').mockResolvedValue({
      payment_proof_url: null, payment_proof_public_id: null,
    })
    const r = await pedirComprobante({ authorization: cliente() })
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/no tiene comprobante/)
  })

  it('devuelve una URL FIRMADA, no la de Cloudinary en crudo', async () => {
    vi.spyOn(db, 'getOrderProof').mockResolvedValue({
      payment_proof_url: 'https://res.cloudinary.com/demo/crudo.jpg',
      payment_proof_public_id: 'botpanel/negocio-a/comprobantes/abc',
    })
    const firmar = vi.spyOn(cloud, 'signedMediaUrl')
      .mockResolvedValue('https://res.cloudinary.com/demo/firmada.jpg?sig=xyz')

    const r = await pedirComprobante({ authorization: cliente() })

    expect(r.status).toBe(200)
    expect(r.body.firmada).toBe(true)
    expect(r.body.url).toContain('sig=')
    expect(firmar).toHaveBeenCalledWith('botpanel/negocio-a/comprobantes/abc')
    // La URL permanente no sale nunca: es la que se reenvía y no caduca.
    expect(r.body.url).not.toBe('https://res.cloudinary.com/demo/crudo.jpg')
  })

  // Los subidos ANTES de esto no tienen identificador. Romperles el acceso
  // escondería el pago de un pedido en curso, que es peor que la fuga que ya
  // ocurrió y que no se puede deshacer.
  it('los comprobantes viejos se siguen viendo, avisando que no van firmados', async () => {
    vi.spyOn(db, 'getOrderProof').mockResolvedValue({
      payment_proof_url: 'https://res.cloudinary.com/demo/viejo.jpg',
      payment_proof_public_id: null,
    })
    const firmar = vi.spyOn(cloud, 'signedMediaUrl')

    const r = await pedirComprobante({ authorization: cliente() })

    expect(r.status).toBe(200)
    expect(r.body.firmada).toBe(false)
    expect(firmar).not.toHaveBeenCalled()
  })

  it('si no se puede firmar, no se cae de vuelta a la URL pública', async () => {
    vi.spyOn(db, 'getOrderProof').mockResolvedValue({
      payment_proof_url: 'https://res.cloudinary.com/demo/crudo.jpg',
      payment_proof_public_id: 'botpanel/negocio-a/comprobantes/abc',
    })
    vi.spyOn(cloud, 'signedMediaUrl').mockResolvedValue(null)

    const r = await pedirComprobante({ authorization: cliente() })

    expect(r.status).toBe(503)
    expect(JSON.stringify(r.body)).not.toContain('cloudinary.com/demo/crudo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE EL SISTEMA LEYÓ DEL COMPROBANTE
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /api/client/orders/:id/receipt-analysis', () => {
  const dueno = { role: 'client', businessId: 'biz-1', urole: 'owner' }

  it('sin sesión no devuelve nada', async () => {
    const resultado = await dispatchAnalisis({})
    expect(resultado.status).toBeGreaterThanOrEqual(401)
  })

  // ⚠️ El identificador del pedido viaja en la URL: el negocio SIEMPRE sale
  // del JWT, nunca de lo que mande el cliente.
  it('el negocio sale del JWT y viaja a la base', async () => {
    const getReceiptAnalysis = vi.spyOn(db, 'getReceiptAnalysis')
      .mockResolvedValue({ receipt_id: 'r1', risk_score: 12, risk_level: 'bajo', flags: [] })
    vi.spyOn(db, 'getBusinessBankAccount').mockResolvedValue({ account_number: '2100123456' })

    const resultado = await dispatchAnalisis({
      authorization: `Bearer ${token(dueno)}`, id: 'ped-9',
    })

    expect(getReceiptAnalysis).toHaveBeenCalledWith('biz-1', 'ped-9')
    expect(resultado.body.analisis.risk_score).toBe(12)
    expect(resultado.body.esperado.account_number).toBe('2100123456')
  })

  it('un pedido sin comprobante registrado no es un error', async () => {
    // Son todos los pedidos anteriores a esta capa: el panel los pinta igual.
    vi.spyOn(db, 'getReceiptAnalysis').mockResolvedValue({ result: 'sin_analisis' })
    const resultado = await dispatchAnalisis({ authorization: `Bearer ${token(dueno)}` })
    expect(resultado.status).toBe(200)
    expect(resultado.body).toEqual({ analisis: null, esperado: null })
  })

  it('si la cuenta bancaria no se puede leer, el análisis se devuelve igual', async () => {
    // Lo que importa es lo detectado; la cuenta esperada es una ayuda.
    vi.spyOn(db, 'getReceiptAnalysis').mockResolvedValue({ receipt_id: 'r1', flags: [] })
    vi.spyOn(db, 'getBusinessBankAccount').mockRejectedValue(new Error('base caída'))
    const resultado = await dispatchAnalisis({ authorization: `Bearer ${token(dueno)}` })
    expect(resultado.status).toBe(200)
    expect(resultado.body.analisis.receipt_id).toBe('r1')
    expect(resultado.body.esperado).toBeNull()
  })

  it('un empleado sin permiso de ventas no lo ve', async () => {
    const resultado = await dispatchAnalisis({
      authorization: `Bearer ${token({
        role: 'client', businessId: 'biz-1', urole: 'staff', perms: ['horarios'],
      })}`,
    })
    expect(resultado.status).toBe(403)
  })
})
