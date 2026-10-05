import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import profileRouter from '../dist/routes/business-profile.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'business-profile-test-secret'

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

function authorization(claims = {}) {
  const signed = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${signed}`
}

async function dispatch(method, path, { auth, body = {}, query = {} } = {}) {
  const routeLayer = profileRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
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

describe('identidad y políticas del negocio', () => {
  // ⚠️ Eran ocho. Las tres de políticas se retiraron el 2026-09-20 con la
  // tabla `bot_policies`: lo que guardaban no lo leía nadie.
  it('protege cinco endpoints y reserva las escrituras para el dueño', async () => {
    const routes = [
      ['get', '/api/client/stats', 2],
      ['get', '/api/client/business', 2],
      ['put', '/api/client/business', 3],
      ['get', '/api/client/bank-account', 3],
      ['put', '/api/client/bank-account', 3],
    ]
    for (const [method, path, handlers] of routes) {
      const layer = profileRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(handlers)
    }

    expect((await dispatch('get', '/api/client/stats')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: [] })
    expect((await dispatch('put', '/api/client/business', { auth: employee })).status).toBe(403)
  })

  it('devuelve únicamente los campos públicos del negocio del JWT', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Demo',
      type: 'tienda',
      slogan: 'Compra fácil',
      description: 'Descripción',
      hours: '09:00-18:00',
      address: 'Centro',
      phone: '0999000001',
      social: '@demo',
      payment_methods: 'Efectivo',
      takes_orders: false,
      suspended: false,
      bot_active: true,
      ycloud_api_key: 'no-debe-salir',
      meta_token: 'no-debe-salir',
      monthly_rate: 99,
      plan: 'enterprise',
      // Sus repartidores propios, encendidos por el superadmin en SU ficha.
      own_fleet: true,
      delivery_by: 'local',
    })

    const response = await dispatch('get', '/api/client/business', {
      auth: authorization(),
      query: { businessId: 'business-b' },
    })

    expect(response.status).toBe(200)
    expect(response.body.id).toBe('business-a')
    expect(response.body).not.toHaveProperty('ycloud_api_key')
    expect(response.body).not.toHaveProperty('meta_token')
    expect(response.body).not.toHaveProperty('monthly_rate')
    expect(response.body).not.toHaveProperty('plan')
    expect(response.body).toMatchObject({
      takes_orders: false,
      flota_propia: true,
    })
    expect(db.getBusinessById).toHaveBeenCalledWith('business-a')
  })

  // Local por local (2026-10-04): solo si el superadmin la encendió en ESTE
  // local y además reparte él mismo. Con «Umbani», la pestaña no sale.
  it('la flota propia solo sale encendida en su local y si reparte él', async () => {
    for (const [local, esperado] of [
      [{ own_fleet: true, delivery_by: 'local' }, true],
      [{ own_fleet: false, delivery_by: 'local' }, false],
      [{ own_fleet: true, delivery_by: 'umbani' }, false],
      [{}, false],
    ]) {
      vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'business-a', name: 'Demo', takes_orders: true, ...local })
      const response = await dispatch('get', '/api/client/business', { auth: authorization() })
      expect(response.status).toBe(200)
      expect(response.body.flota_propia).toBe(esperado)
    }
  })

  it('solo actualiza campos permitidos y usa el negocio del JWT', async () => {
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

    const response = await dispatch('put', '/api/client/business', {
      auth: authorization(),
      body: {
        name: 'Nuevo nombre',
        slogan: 'Nuevo slogan',
        ycloud_api_key: 'intento-de-cambio',
        plan: 'enterprise',
        // Quién lleva sus pedidos lo decide el superadmin, no el local.
        own_fleet: true,
        delivery_by: 'local',
        businessId: 'business-b',
      },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      name: 'Nuevo nombre',
      slogan: 'Nuevo slogan',
    })
  })

  // ── Los tiempos del negocio ──────────────────────────────────────────────
  //
  // ⚠️ Una cadena VACÍA no es un cero. `Number('')` vale 0, así que un campo
  // que llegue vacío guardaba 0 en silencio y el negocio se quedaba prometiendo
  // la comida sin sumar el reparto sin haberlo pedido nunca. Se descubrió
  // verificando contra producción: arreglarlo solo en el formulario no bastaba,
  // porque la API la seguía aceptando.
  it('un tiempo vacío se rechaza en vez de guardarse como cero', async () => {
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

    for (const cuerpo of [
      { delivery_extra_minutes: '' },
      { delivery_extra_minutes: '   ' },
      { delivery_extra_minutes: null },
      { prep_time_minutes: '' },
    ]) {
      const response = await dispatch('put', '/api/client/business', {
        auth: authorization(),
        body: cuerpo,
      })
      expect(response.status, JSON.stringify(cuerpo)).toBe(400)
    }
    expect(updateBusiness).not.toHaveBeenCalled()
  })

  it('un cero escrito a propósito SÍ se guarda en el tiempo de entrega', async () => {
    // Es legítimo: un negocio que solo atiende su cuadra entrega en lo que
    // tarda en cruzar la calle. Solo se rechaza lo que no es un número.
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

    const response = await dispatch('put', '/api/client/business', {
      auth: authorization(),
      body: { delivery_extra_minutes: 0 },
    })

    expect(response.status).toBe(200)
    expect(updateBusiness).toHaveBeenCalledWith('business-a', { delivery_extra_minutes: 0 })
  })

  // ── Los dos frenos del local (2026-08-26) ────────────────────────────────
  //
  // Nacen del caso de las cuarenta personas: alguien pasa el enlace en un
  // grupo con «pidan una gaseosa, es gratis». Cada uno hace UN pedido, así que
  // el freno por cliente no ve nada, y a la cocina le entran cuarenta comandas
  // de $1,50 a la vez.
  describe('el pedido mínimo y el tope por hora', () => {
    it('los guarda con decimales y los acota como la base', async () => {
      const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

      const ok = await dispatch('put', '/api/client/business', {
        auth: authorization(),
        body: { min_order_amount: '5.005', max_orders_per_hour: 40 },
      })
      expect(ok.status).toBe(200)
      // Se redondea a centavos: el CHECK de la base guarda numeric(10,2) y un
      // tercer decimal se perdería en silencio al escribirlo.
      expect(updateBusiness).toHaveBeenCalledWith('business-a', {
        min_order_amount: 5.01, max_orders_per_hour: 40,
      })
    })

    // ── La espera del comprobante (2026-08-28) ───────────────────────────
    //
    // Aquí el 0 SÍ vale, al revés que en el tope por hora: significa «no
    // expirar nunca», y quien cobra contra entrega o coordina por teléfono
    // tiene motivos legítimos para quererlo. Su dominio NO es continuo, por
    // eso se valida aparte del bucle de rangos.
    it('la espera del comprobante acepta 0 y el rango 15-1440', async () => {
      const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})
      for (const minutos of [0, 15, 120, 1440]) {
        updateBusiness.mockClear()
        const ok = await dispatch('put', '/api/client/business', {
          auth: authorization(), body: { payment_window_minutes: minutos },
        })
        expect(ok.status, `${minutos} debería valer`).toBe(200)
        expect(updateBusiness).toHaveBeenCalledWith('business-a', {
          payment_window_minutes: minutos,
        })
      }
    })

    // ⚠️ 5 minutos no le da tiempo ni a hacer la transferencia: el pedido se
    // cancelaría mientras el cliente está en la app del banco.
    it('rechaza esperas imposibles y valores a medias', async () => {
      for (const cuerpo of [
        { payment_window_minutes: 5 },
        { payment_window_minutes: 14 },
        { payment_window_minutes: 1441 },
        { payment_window_minutes: -10 },
        { payment_window_minutes: 30.5 },
        { payment_window_minutes: '' },
        { payment_window_minutes: null },
        { payment_window_minutes: 'pronto' },
      ]) {
        const response = await dispatch('put', '/api/client/business', {
          auth: authorization(), body: cuerpo,
        })
        expect(response.status, JSON.stringify(cuerpo)).toBe(400)
      }
    })

    // CERO es «sin mínimo», un valor que el dueño elige a propósito. Es el
    // mismo cuidado que con el tiempo de entrega.
    it('el cero del mínimo SÍ se guarda', async () => {
      const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})
      const response = await dispatch('put', '/api/client/business', {
        auth: authorization(), body: { min_order_amount: 0 },
      })
      expect(response.status).toBe(200)
      expect(updateBusiness).toHaveBeenCalledWith('business-a', { min_order_amount: 0 })
    })

    // ⚠️ Un campo VACÍO no es un cero: `Number('')` vale 0, así que borrarlo
    // para reescribirlo guardaría «sin mínimo» sin haberlo pedido. Y un tope
    // de cero dejaría al local sin poder recibir un solo pedido.
    it('rechaza lo que no es un número, y el tope de cero', async () => {
      const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({})

      for (const cuerpo of [
        { min_order_amount: '' },
        { min_order_amount: '   ' },
        { min_order_amount: null },
        { min_order_amount: -1 },
        { min_order_amount: 1000 },
        { max_orders_per_hour: 0 },
        { max_orders_per_hour: '' },
        { max_orders_per_hour: 501 },
        { max_orders_per_hour: 2.5 },
      ]) {
        const response = await dispatch('put', '/api/client/business', {
          auth: authorization(), body: cuerpo,
        })
        expect(response.status, JSON.stringify(cuerpo)).toBe(400)
      }
      expect(updateBusiness).not.toHaveBeenCalled()
    })

    it('el error dice qué rango se espera, no «valor inválido»', async () => {
      vi.spyOn(db, 'updateBusiness').mockResolvedValue({})
      const minimo = await dispatch('put', '/api/client/business', {
        auth: authorization(), body: { min_order_amount: -1 },
      })
      expect(minimo.body.error).toMatch(/entre 0 y 999/)
      const tope = await dispatch('put', '/api/client/business', {
        auth: authorization(), body: { max_orders_per_hour: 0 },
      })
      expect(tope.body.error).toMatch(/entre 1 y 500/)
    })
  })

  it('no confirma errores de Supabase al actualizar la identidad', async () => {
    const updateBusiness = vi.spyOn(db, 'updateBusiness')
      .mockResolvedValue({ error: { message: 'detalle interno' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const failed = await dispatch('put', '/api/client/business', {
      auth: authorization(), body: { name: 'Nombre actualizado' },
    })
    expect(failed).toEqual({
      status: 500, body: { error: 'No se pudo actualizar el negocio' },
    })
    expect(JSON.stringify(failed.body)).not.toContain('detalle interno')
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      name: 'Nombre actualizado',
    })
  })

  // ── Cuenta bancaria ───────────────────────────────────────────────────────
  //
  // El dueño dijo que estos datos NO son secretos: son con los que le pagan.
  // Aun así son del dueño y no del empleado — a qué cuenta entra el dinero no
  // es cosa de quien gestiona el catálogo.
  describe('cuenta bancaria', () => {
    it('un empleado no la ve ni la cambia', async () => {
      const employee = authorization({ urole: 'employee', perms: ['catalogo'] })
      expect((await dispatch('get', '/api/client/bank-account', { auth: employee })).status).toBe(403)
      expect((await dispatch('put', '/api/client/bank-account', { auth: employee })).status).toBe(403)
    })

    it('guarda solo los campos saneados y en su propio negocio', async () => {
      const guardar = vi.spyOn(db, 'upsertBankAccount').mockResolvedValue({ error: null })

      const respuesta = await dispatch('put', '/api/client/bank-account', {
        auth: authorization(),
        body: {
          bank_name: '  Banco Pichincha  ',
          account_type: 'corriente',
          account_number: '2100123456',
          holder_name: 'Yover Rosado',
          holder_id: '0912345678',
          instructions: 'Manda el comprobante por WhatsApp',
          business_id: 'business-b',
          active: false,
        },
      })

      expect(respuesta.status).toBe(200)
      expect(guardar).toHaveBeenCalledWith('business-a', {
        bank_name: 'Banco Pichincha',
        account_type: 'corriente',
        account_number: '2100123456',
        holder_name: 'Yover Rosado',
        holder_id: '0912345678',
        instructions: 'Manda el comprobante por WhatsApp',
      })
    })

    it('un tipo de cuenta inventado cae en ahorros, que es lo que acepta la base', async () => {
      const guardar = vi.spyOn(db, 'upsertBankAccount').mockResolvedValue({ error: null })

      await dispatch('put', '/api/client/bank-account', {
        auth: authorization(),
        body: {
          bank_name: 'Banco', account_type: 'cripto',
          account_number: '1', holder_name: 'Alguien',
        },
      })

      expect(guardar.mock.calls[0][1].account_type).toBe('ahorros')
    })

    it('exige banco, número y titular', async () => {
      const guardar = vi.spyOn(db, 'upsertBankAccount')

      for (const body of [
        { account_number: '1', holder_name: 'A' },
        { bank_name: 'B', holder_name: 'A' },
        { bank_name: 'B', account_number: '1' },
      ]) {
        const respuesta = await dispatch('put', '/api/client/bank-account', {
          auth: authorization(), body,
        })
        expect(respuesta.status, JSON.stringify(body)).toBe(400)
      }
      expect(guardar).not.toHaveBeenCalled()
    })

    it('devuelve null cuando el negocio aún no cargó su cuenta', async () => {
      vi.spyOn(db, 'getBusinessBankAccount').mockResolvedValue(null)

      const respuesta = await dispatch('get', '/api/client/bank-account', {
        auth: authorization(),
      })

      expect(respuesta.status).toBe(200)
      expect(respuesta.body).toBeNull()
    })
  })
})
