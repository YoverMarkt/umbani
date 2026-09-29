import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import clientsRouter from '../dist/routes/admin-clients.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const bcrypt = require('bcryptjs')
const JWT_SECRET = 'admin-clients-test-secret'
let originalJwtSecret
let originalYCloudWebhookSecret
let originalYCloudWebhookEndpointId

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  originalYCloudWebhookSecret = process.env.YCLOUD_WEBHOOK_SECRET
  originalYCloudWebhookEndpointId = process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
  process.env.JWT_SECRET = JWT_SECRET
  process.env.YCLOUD_WEBHOOK_SECRET = 'ycloud-signing-secret-test'
  process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = 'ycloud-endpoint-test'
  // El alta busca un slug libre, así que consulta la base. Sin este simulacro
  // la ruta llamaría a Supabase de verdad y el test se quedaba colgado hasta
  // agotar el tiempo — que es exactamente lo que pasó al añadirlo.
  vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
  if (originalYCloudWebhookSecret === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET
  else process.env.YCLOUD_WEBHOOK_SECRET = originalYCloudWebhookSecret
  if (originalYCloudWebhookEndpointId === undefined) {
    delete process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
  } else {
    process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = originalYCloudWebhookEndpointId
  }
})

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, mfa: true, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth, body = {}, params = {}, query = {} } = {}) {
  const layer = clientsRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
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

describe('clientes y onboarding del superadmin', () => {
  // 17 hasta el 2026-08-25; 19 con las dos del bloqueo de PLATAFORMA (leer la
  // lista y cambiar el estado de un número). El número exacto es lo que obliga
  // a mirar aquí cuando alguien añade una ruta: una nueva sin autenticación
  // pasaría inadvertida, y estas hablan de todos los negocios a la vez.
  it('protege sus 19 endpoints exclusivamente con autenticación admin', async () => {
    // 21 desde el 2026-09-18: entraron la lista de cajones del menú del chat y
    // el uso de Umbani.
    // El número se sube A MANO y a propósito — una ruta nueva que se colara
    // sin `authAdmin` tiene que romper esta prueba, no pasar de largo.
    expect(clientsRouter.stack).toHaveLength(19)
    expect(clientsRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('get', '/api/admin/clients')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/clients', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('la salud del canal también exige superadmin', async () => {
    expect((await dispatch('get', '/api/admin/channel-health')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/channel-health', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  // ── La salud del canal, después de la corrección del 2026-08-23 ──────────
  //
  // Esto NO comprueba el cálculo (de eso va `channel-health.test.js`), sino el
  // CABLEADO: que la ruta pregunte de verdad por el número de la plataforma y
  // que no gaste una consulta por cada local que nunca puede responderla.
  // Justo lo que faltaba antes: la lógica del semáforo era correcta y estaba
  // alimentada con una consulta que devolvía null para siempre.
  describe('la vigilancia del canal pregunta por el número de la plataforma', () => {
    const settings = require('../dist/services/settings')

    beforeEach(() => {
      // Las credenciales del número viven en `server_settings`, no en un negocio.
      vi.spyOn(settings, 'get').mockImplementation(async key => ({
        platform_ycloud_api_key: 'clave',
        platform_ycloud_number: '+593991716574',
        platform_webhook_secret: 'whsec_x',
        platform_webhook_endpoint_id: 'ep_x',
      })[key] ?? null)
    })

    it('devuelve el estado del número y no consulta por los locales de marketplace', async () => {
      vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([{
        id: 'business-a', name: 'Monster Pizza', active: true, suspended: false,
        whatsapp_provider: 'marketplace',
      }])
      const porNegocio = vi.spyOn(db, 'getLastInboundByBusiness').mockResolvedValue([])
      vi.spyOn(db, 'getPlatformLastInboundAt')
        .mockResolvedValue(new Date(Date.now() - 60_000).toISOString())

      const response = await dispatch('get', '/api/admin/channel-health', {
        auth: authorization('admin'),
      })

      expect(response.status).toBe(200)
      expect(response.body.platform.status).toBe('ok')
      expect(response.body.businesses).toEqual([])
      expect(response.body.alert).toBe(false)
      // Con cero negocios de canal propio, la lista de ids va vacía: preguntar
      // por un local de marketplace es gastar una consulta para recibir null.
      expect(porNegocio).toHaveBeenCalledWith([])
    })

    it('alerta cuando el número de la plataforma lleva horas mudo', async () => {
      vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([])
      vi.spyOn(db, 'getLastInboundByBusiness').mockResolvedValue([])
      vi.spyOn(db, 'getPlatformLastInboundAt')
        .mockResolvedValue(new Date(Date.now() - 30 * 3_600_000).toISOString())

      const response = await dispatch('get', '/api/admin/channel-health', {
        auth: authorization('admin'),
      })
      expect(response.body.platform.status).toBe('silencio')
      expect(response.body.alert).toBe(true)
    })

    // Un fallo leyendo `server_settings` no puede tumbar la vigilancia: es el
    // mismo criterio que dejó el canal mudo cinco días en julio.
    it('sobrevive a un fallo leyendo los ajustes del servidor', async () => {
      settings.get.mockRejectedValue(new Error('base caída'))
      vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([])
      vi.spyOn(db, 'getLastInboundByBusiness').mockResolvedValue([])
      vi.spyOn(db, 'getPlatformLastInboundAt').mockResolvedValue(null)

      const response = await dispatch('get', '/api/admin/channel-health', {
        auth: authorization('admin'),
      })
      expect(response.status).toBe(200)
      expect(response.body.platform.status).toBe('sin_canal')
      expect(response.body.alert).toBe(false)
    })

    // Se retiró del contrato el 2026-08-23: nadie lo pintaba y descartaba los
    // errores con `business_id` NULL, que hoy son la mayoría.
    it('ya no devuelve errorsByBusiness', async () => {
      vi.spyOn(db, 'getAllBusinesses').mockResolvedValue([])
      vi.spyOn(db, 'getLastInboundByBusiness').mockResolvedValue([])
      vi.spyOn(db, 'getPlatformLastInboundAt').mockResolvedValue(null)

      const response = await dispatch('get', '/api/admin/channel-health', {
        auth: authorization('admin'),
      })
      expect(response.body).not.toHaveProperty('errorsByBusiness')
    })
  })

  // Bloquear en toda la plataforma es la acción más fuerte del panel: deja a
  // una persona fuera de TODOS los locales. Jamás al alcance de un dueño.
  it('el bloqueo de plataforma exige superadmin', async () => {
    expect((await dispatch('get', '/api/admin/blocked')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/blocked', {
      auth: authorization('client'),
    })).status).toBe(403)
    expect((await dispatch('put', '/api/admin/blocked/:phone', {
      auth: authorization('client'), params: { phone: '593900000825' },
    })).status).toBe(403)
  })

  it('bloquea y desbloquea por teléfono, con su motivo', async () => {
    const marcar = vi.spyOn(db, 'setPlatformBlocked')
      .mockResolvedValue({ phone: '593900000825', blocked: true })

    await dispatch('put', '/api/admin/blocked/:phone', {
      auth: authorization('admin'),
      params: { phone: '%2B593900000825' },
      body: { blocked: true, reason: 'pedidos falsos' },
    })
    expect(marcar).toHaveBeenCalledWith('+593900000825', true, 'pedidos falsos')

    // Sin `blocked: true` explícito se DESbloquea: un cuerpo raro no puede
    // acabar dejando a alguien fuera de la plataforma entera.
    await dispatch('put', '/api/admin/blocked/:phone', {
      auth: authorization('admin'), params: { phone: '593900000825' }, body: {},
    })
    expect(marcar).toHaveBeenLastCalledWith('593900000825', false, null)
  })

  // Un teléfono mal escrito SÍ se le dice al superadmin; cualquier otro fallo
  // se registra sin exponer el detalle.
  it('distingue un teléfono inválido de un fallo interno', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const marcar = vi.spyOn(db, 'setPlatformBlocked')
      .mockRejectedValue(new Error('El teléfono debe tener entre 8 y 15 dígitos'))
    const corto = await dispatch('put', '/api/admin/blocked/:phone', {
      auth: authorization('admin'), params: { phone: '5939' }, body: { blocked: true },
    })
    expect(corto.status).toBe(400)
    expect(corto.body.error).toMatch(/dígitos/)

    marcar.mockRejectedValue(new Error('connection reset by peer'))
    const roto = await dispatch('put', '/api/admin/blocked/:phone', {
      auth: authorization('admin'), params: { phone: '593900000825' }, body: { blocked: true },
    })
    expect(roto.status).toBe(500)
    expect(roto.body.error).not.toContain('connection reset')
  })

  // El registro puede describir fallos de cualquier negocio: jamás debe quedar
  // al alcance de un cliente.
  it('el registro de errores y su descarga exigen superadmin', async () => {
    for (const path of ['/api/admin/errors', '/api/admin/errors/export']) {
      expect((await dispatch('get', path)).status).toBe(401)
      expect((await dispatch('get', path, {
        auth: authorization('client'),
      })).status).toBe(403)
    }
  })

  it('devuelve el detalle sin credenciales y con su estado de configuración', async () => {
    // Los cajones del menú son una consulta más del detalle (2026-09-17).
    vi.spyOn(db, 'getBusinessMarketplaceCategories').mockResolvedValue([])
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Mas Pura', ycloud_api_key: 'ycloud-secret',
      ycloud_webhook_secret: 'ycloud-signing-secret',
      ycloud_webhook_endpoint_id: 'endpoint-a',
      meta_token: 'meta-secret',
    })
    vi.spyOn(db, 'getClientUserByBusiness').mockResolvedValue({ email: 'owner@example.com' })

    const response = await dispatch('get', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
    })

    expect(response.body).toMatchObject({
      id: 'business-a',
      client_email: 'owner@example.com',
      credential_status: {
        ycloud_api_key: true,
        ycloud_webhook_secret: true,
        meta_token: true,
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('ycloud-secret')
    expect(JSON.stringify(response.body)).not.toContain('ycloud-signing-secret')
    expect(JSON.stringify(response.body)).not.toContain('meta-secret')
  })

  // La dirección de la tienda viaja en un WhatsApp y la lee una persona:
  // `pizzeria-don-pepe` dice de quién es, `pizzeria-don-pepe-1785656324571`
  // parece un identificador de sistema y ocupa el doble.
  it('el negocio nace con una dirección corta, sin el reloj pegado', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-new', name: 'Pizzería Don Pepe' }, error: null,
    })

    await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Pizzería Don Pepe', whatsapp_number: '+593999000009',
        client_email: 'owner@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
      },
    })

    // Y la tilde se CONVIERTE, no se borra: antes daba `pizzera`.
    expect(createOnboarding.mock.calls[0][0].slug).toBe('pizzeria-don-pepe')
  })

  // ── La carta del local (2026-09-24) ─────────────────────────────────────
  // El dueño sube la foto de la carta al dar de alta el local, la IA propone y
  // él la revisa. «Lo mejor, al momento de dar de alta»: lo real ocupa el
  // sitio de los productos de ejemplo, nunca los dos.
  describe('el alta con la carta revisada', () => {
    const altaCon = carta => dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'La Abuelita 2', whatsapp_number: '+593999000010', type: 'almuerzos',
        client_email: 'abuelita@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
        carta,
      },
    })
    const cartaRevisada = {
      categorias: [{ nombre: 'Almuerzos', productos: [{
        nombre: 'Almuerzo del día', precio: 3.5,
        listas: [{ titulo: 'Sopa', opciones: ['Caldo de hueso de res', 'Crema de zapallo'] }],
      }] }],
    }

    it('carga la carta EN LUGAR de los productos de ejemplo', async () => {
      vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
        data: { id: 'business-carta', name: 'La Abuelita 2' }, error: null,
      })
      const plantilla = vi.spyOn(db, 'applyBusinessTemplate')
      const menu = vi.spyOn(db, 'applyBusinessMenu').mockResolvedValue({
        data: { aplicada: true, categorias: 1, listas: 0, productos: 1, grupos: 1, opciones: 2, variantes: 0 },
        error: null,
      })

      const respuesta = await altaCon(cartaRevisada)

      expect(respuesta.status).toBe(201)
      expect(plantilla).not.toHaveBeenCalled()
      const [negocio, carta] = menu.mock.calls[0]
      expect(negocio).toBe('business-carta')
      expect(carta.categorias[0].productos[0]).toMatchObject({
        nombre: 'Almuerzo del día', precio: 3.5, tipo: 'configurable',
      })
      expect(respuesta.body.carta).toMatchObject({ aplicada: true, productos: 1 })
      expect(respuesta.body.aviso).toBeUndefined()
    })

    it('una carta con algo por corregir no crea el local', async () => {
      const crear = vi.spyOn(db, 'createBusinessOnboarding')
      const conHueco = structuredClone(cartaRevisada)
      conHueco.categorias[0].productos[0].precio = null

      const respuesta = await altaCon(conHueco)

      expect(respuesta.status).toBe(400)
      expect(respuesta.body.errores).toEqual(['Almuerzos › Almuerzo del día: falta el precio'])
      expect(crear).not.toHaveBeenCalled()
    })

    it('si la carta no entra, el local queda creado y el alta lo AVISA', async () => {
      vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
        data: { id: 'business-carta', name: 'La Abuelita 2' }, error: null,
      })
      vi.spyOn(db, 'applyBusinessMenu').mockResolvedValue({
        data: null, error: { message: 'se cayó la base' },
      })
      const plantilla = vi.spyOn(db, 'applyBusinessTemplate')
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const respuesta = await altaCon(cartaRevisada)

      expect(respuesta.status).toBe(201)
      expect(respuesta.body.aviso).toMatch(/la carta no se pudo guardar/)
      // Ni siquiera entonces se siembran los ejemplos: alguien revisó una
      // carta y tiene que ver que no entró, no un catálogo que no pidió.
      expect(plantilla).not.toHaveBeenCalled()
    })

    it('sin carta, el alta sigue sembrando los ejemplos de su tipo como siempre', async () => {
      vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
        data: { id: 'business-sin-carta', name: 'La Abuelita 2' }, error: null,
      })
      const plantilla = vi.spyOn(db, 'applyBusinessTemplate').mockResolvedValue({
        data: { aplicada: true, categorias: 1, listas: 0, productos: 1, grupos: 0, opciones: 0 },
        error: null,
      })
      const menu = vi.spyOn(db, 'applyBusinessMenu')

      const respuesta = await altaCon(undefined)

      expect(respuesta.status).toBe(201)
      expect(plantilla).toHaveBeenCalledWith('business-sin-carta', expect.any(Object))
      expect(menu).not.toHaveBeenCalled()
      expect(respuesta.body.carta).toBeUndefined()
    })
  })

  // ⚠️ 2026-09-24. «Ese dato ya está registrado» no decía CUÁL, y el dueño
  // repitió el alta cinco veces: era el correo, que el navegador rellenó solo.
  it('un correo de dueño que ya tiene cuenta se dice por su nombre', async () => {
    vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: null,
      error: { message: 'duplicate key value violates unique constraint "client_users_email_key"' },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const respuesta = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Otro local', whatsapp_number: '+593999000011',
        client_email: 'demo@umbani.local', client_password: 'safe-password-12',
        ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
      },
    })

    expect(respuesta.status).toBe(409)
    expect(respuesta.body.error).toBe(
      'Ese correo ya es el acceso al panel de otro negocio. Usa otro correo para este dueño.',
    )
  })

  it('si la dirección ya existe, prueba la siguiente en vez de fallar', async () => {
    vi.spyOn(db, 'getBusinessBySlug').mockImplementation(
      async slug => (slug === 'pizzeria-don-pepe' ? { id: 'otro' } : null),
    )
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-new' }, error: null,
    })

    await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Pizzería Don Pepe', whatsapp_number: '+593999000010',
        client_email: 'owner2@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
      },
    })

    expect(createOnboarding.mock.calls[0][0].slug).toBe('pizzeria-don-pepe-2')
  })

  it('crea negocio, políticas, usuario y facturación sin exponer secretos', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-new', name: 'Nueva', ycloud_api_key: 'secret' },
      error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: ' Nueva ', whatsapp_number: ' +593999000001 ', monthly_rate: '30',
        client_email: 'owner@example.com', client_password: 'safe-password',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Nueva', whatsapp_number: '+593999000001',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
      }),
      'owner@example.com',
      expect.any(String),
      25,
    )
    const passwordHash = createOnboarding.mock.calls[0][2]
    expect(passwordHash).not.toBe('safe-password')
    expect(await bcrypt.compare('safe-password', passwordHash)).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('"ycloud_api_key":"secret"')
    expect(JSON.stringify(response.body)).not.toContain('signing-secret-new')
  })

  it('aplica los límites recomendados cuando se elige un plan', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-pro', name: 'Nueva Pro' },
      error: null,
    })
    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva Pro',
        whatsapp_number: '+593999000001',
        monthly_rate: '99',
        plan: 'pro',
        client_email: 'owner@example.com',
        client_password: 'safe-password',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-pro',
        ycloud_webhook_secret: 'signing-secret-pro',
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(expect.objectContaining({
      plan: 'pro',
      monthly_contact_limit: 400,
      monthly_outbound_message_limit: 2000,
    }), 'owner@example.com', expect.any(String), 99)
    expect(response.body).toMatchObject({
      monthly_contact_limit: 400,
      monthly_outbound_message_limit: 2000,
    })
  })

  it('rechaza teléfonos locales antes de crear o actualizar el negocio', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const creation = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva', whatsapp_number: '0999000001', monthly_rate: '30',
        client_email: 'owner@example.com', client_password: 'safe-password',
        ycloud_api_key: 'secret',
      },
    })
    const update = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_number: '0999000001' },
    })

    expect(creation.status).toBe(400)
    expect(update.status).toBe(400)
    expect(creation.body.error).toContain('E.164')
    expect(update.body.error).toContain('E.164')
    expect(createOnboarding).not.toHaveBeenCalled()
    expect(updateBusiness).not.toHaveBeenCalled()
  })

  it('explica que el número de WhatsApp ya es de otro negocio en vez de fallar en genérico', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Negocio ya configurado: la ruta valida el estado final, no solo el formulario
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Hostal',
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'clave-ycloud',
      ycloud_webhook_secret: 'secreto-webhook',
      ycloud_webhook_endpoint_id: '6a41a4f44de0392666e757f4',
    })
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({
      error: {
        message: 'duplicate key value violates unique constraint "businesses_whatsapp_number_key"',
      },
    })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_number: '+593991716574' },
    })

    // El número identifica al negocio dentro del bot: la base lo bloquea y el
    // panel debe decir POR QUÉ, no un "no se pudo actualizar" a ciegas
    expect(response.status).toBe(409)
    expect(response.body.error).toContain('ya está asignado a otro negocio')
    expect(response.body.error).not.toContain('duplicate key')
  })

  it('no ejecuta escrituras compensatorias si la RPC atómica rechaza el onboarding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })
    const cleanup = vi.spyOn(db, 'deleteBusiness')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva',
        whatsapp_number: '+593999000001',
        monthly_rate: '30',
        client_email: 'owner@example.com',
        client_password: 'safe-password',
        ycloud_api_key: 'secret',
      },
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo crear el cliente' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it('rechaza credenciales incompletas antes de invocar la base', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva', whatsapp_number: '+593999000001',
        client_email: 'owner@example.com',
      },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'Email y password deben enviarse juntos' },
    })
    expect(createOnboarding).not.toHaveBeenCalled()
  })

  it('rechaza contraseñas nuevas con menos de doce caracteres', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding')

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Nueva',
        whatsapp_number: '+593999000001',
        client_email: 'owner@example.com',
        client_password: 'corta',
      },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'La contraseña debe tener al menos 12 caracteres' },
    })
    expect(createOnboarding).not.toHaveBeenCalled()
  })

  it('acepta un negocio configurado para operar solo por Telegram', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-telegram', name: 'Telegram' }, error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Telegram', whatsapp_number: '+593000000000', monthly_rate: '20',
        whatsapp_provider: 'telegram', telegram_bot_token: 'bot-token',
        client_email: 'owner@example.com', client_password: 'safe-password',
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ whatsapp_provider: 'telegram', telegram_bot_token: 'bot-token' }),
      'owner@example.com', expect.any(String), 25,
    )
  })

  it('reaplica deliberadamente los valores vigentes sin tocar cobros históricos', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      plan: 'basic',
      monthly_rate: 49,
      monthly_contact_limit: 50,
      monthly_outbound_message_limit: 250,
      whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001',
      ycloud_api_key: 'stored-secret',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness')
    const updatePlan = vi.spyOn(db, 'updateBusinessPlanBilling').mockResolvedValue({
      error: null,
    })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(),
      params: { id: 'business-a' },
      body: { plan: 'basic', apply_plan_defaults: true },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(updateBusiness).not.toHaveBeenCalled()
    expect(updatePlan).toHaveBeenCalledWith('business-a', 'basic', 50, 200, 1000)
  })

  it('solo envía campos permitidos y no confirma una facturación rechazada', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', plan: 'micro', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'stored-secret',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
    const updatePlan = vi.spyOn(db, 'updateBusinessPlanBilling').mockResolvedValue({
      error: { message: 'fallo de base' },
    })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: {
        name: 'Actualizado', plan: 'pro', monthly_rate: '25', id: 'business-b',
        client_password: 'never-in-business', unknown: 'discard',
      },
    })

    expect(updateBusiness).toHaveBeenCalledWith('business-a', { name: 'Actualizado' })
    expect(updatePlan).toHaveBeenCalledWith('business-a', 'pro', 99, 400, 2000)
    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo actualizar el cliente' },
    })
  })

  it('rechaza proveedores no permitidos antes de consultar o modificar el negocio', async () => {
    const getBusiness = vi.spyOn(db, 'getBusinessById')
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'legacy-provider' },
    })

    expect(response).toEqual({
      status: 400,
      body: { error: 'Proveedor de mensajería no válido' },
    })
    expect(getBusiness).not.toHaveBeenCalled()
    expect(updateBusiness).not.toHaveBeenCalled()
  })

  it('valida un cambio de proveedor con los secretos guardados y el payload nuevo', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'ycloud-stored',
      meta_token: 'meta-stored', meta_phone_id: 'phone-old',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'meta', meta_phone_id: 'phone-new' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(updateBusiness).toHaveBeenCalledWith('business-a', {
      whatsapp_provider: 'meta', meta_phone_id: 'phone-new',
    })
    expect(JSON.stringify(response.body)).not.toContain('meta-stored')
  })

  it('no cambia a Meta cuando la configuración efectiva no tiene token', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001', ycloud_api_key: 'ycloud-stored',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness')

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { whatsapp_provider: 'meta', meta_phone_id: 'phone-new' },
    })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('Meta requiere Token y Phone ID')
    expect(updateBusiness).not.toHaveBeenCalled()
    expect(JSON.stringify(response.body)).not.toContain('ycloud-stored')
  })

  // El interruptor del bot vive en su propia ruta y NO en el PUT del negocio.
  // El PUT valida el canal entero, así que pausar un bot con credenciales a
  // medias fallaría pidiendo el Signing Secret de YCloud — justo cuando más
  // falta hace poder pausarlo. Estas pruebas fijan esa diferencia.
  it('pausa el bot aunque al negocio le falten credenciales del canal', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Pizzería', suspended: false, bot_active: true,
      whatsapp_provider: 'ycloud', ycloud_api_key: null, ycloud_webhook_secret: null,
    })
    const setBotActive = vi.spyOn(db, 'setBotActive').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/clients/:id/bot', {
      auth: authorization(), params: { id: 'business-a' }, body: { active: false },
    })

    expect(response).toEqual({ status: 200, body: { ok: true, bot_active: false } })
    expect(setBotActive).toHaveBeenCalledWith('business-a', false)
  })

  it('no enciende el bot de un negocio suspendido', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Pizzería', suspended: true, bot_active: false,
    })
    const setBotActive = vi.spyOn(db, 'setBotActive').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/clients/:id/bot', {
      auth: authorization(), params: { id: 'business-a' }, body: { active: true },
    })

    expect(response.status).toBe(409)
    expect(setBotActive).not.toHaveBeenCalled()
  })

  it('rechaza el interruptor del bot sin un valor booleano', async () => {
    const setBotActive = vi.spyOn(db, 'setBotActive').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/clients/:id/bot', {
      auth: authorization(), params: { id: 'business-a' }, body: { active: 'si' },
    })

    expect(response.status).toBe(400)
    expect(setBotActive).not.toHaveBeenCalled()
  })

  it.each([
    ['post', '/api/admin/clients/:id/suspend', 'suspendBusiness'],
    ['post', '/api/admin/clients/:id/reactivate', 'reactivateBusiness'],
  ])('no devuelve éxito cuando %s %s falla', async (method, path, operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, operation).mockResolvedValue({ error: { message: 'fallo interno' } })

    const response = await dispatch(method, path, {
      auth: authorization(), params: { id: 'business-a' }, body: {},
    })

    expect(response.status).toBe(500)
    expect(response.body.ok).not.toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('fallo interno')
  })

  it('crea el usuario únicamente dentro del negocio indicado por la ruta', async () => {
    const createClientUser = vi.spyOn(db, 'createClientUser').mockResolvedValue({ error: null })

    const response = await dispatch('post', '/api/admin/clients/:id/create-user', {
      auth: authorization(), params: { id: 'business-a' },
      body: { business_id: 'business-b', email: 'owner@example.com', password: 'secret-123456' },
    })

    expect(response).toEqual({ status: 200, body: { ok: true } })
    expect(createClientUser).toHaveBeenCalledWith(expect.objectContaining({
      business_id: 'business-a', email: 'owner@example.com',
    }))
  })

  // La tienda se enciende desde el panel del superadmin. Sin este campo en la
  // lista blanca el interruptor existiría en la pantalla pero no guardaría
  // nada — que es justo como estaba antes de construirlo.
  it('guarda el interruptor de la mini app al crear', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-pizza', name: 'Pizzería' },
      error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Pizzería', whatsapp_number: '+593999000002', monthly_rate: '30',
        client_email: 'duena@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
        chat_mode: 'miniapp',
        takes_orders: true,
        storefront_enabled: true,
      },
    })

    expect(response.status).toBe(201)
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ storefront_enabled: true }),
      expect.any(String), expect.any(String), expect.any(Number),
    )
  })

  // ⚠️ ESTA PRUEBA DECÍA LO CONTRARIO HASTA EL 2026-09-16, y la vuelta es la
  // decisión, no un ajuste: rechazaba el alta de un negocio en modo mini app
  // sin pedidos o sin tienda.
  //
  // Tenía sentido mientras hubiera OTRO modo al que caer — el negocio sin
  // tienda se quedaba en `menu` y atendía igual. Retirado el menú, esa regla
  // pasaba a significar «todo local tiene que vender», y eso es falso: un local
  // se da de alta OCULTO mientras carga su catálogo, que es justo lo que
  // recomienda el propio panel («enciéndelo con el catálogo ya cargado»).
  it.each([
    [{ takes_orders: false, storefront_enabled: false }, 'oculto del todo'],
    [{ takes_orders: true, storefront_enabled: false }, 'sin tienda todavía'],
  ])('crea un local oculto sin pelearse con el modo (%j)', async (capacidades) => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-oculto', name: 'Tienda en preparación' },
      error: null,
    })

    const response = await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Tienda en preparación',
        whatsapp_number: '+593999000099',
        client_email: 'incompleta@example.com',
        client_password: 'safe-password-12',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
        ...capacidades,
      },
    })

    expect(response.status).toBe(201)
    // Y nace en el único modo que existe, sin que nadie lo haya pedido.
    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ chat_mode: 'miniapp', ...capacidades }),
      expect.any(String), expect.any(String), expect.any(Number),
    )
  })

  // Nace apagada: encenderla sin catálogo cargado le daría al cliente final una
  // tienda vacía, que se ve peor que no tener tienda.
  it('la tienda nace apagada si no se pide', async () => {
    const createOnboarding = vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
      data: { id: 'business-barber', name: 'Barbería' },
      error: null,
    })

    await dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'Barbería', whatsapp_number: '+593999000003', monthly_rate: '30',
        client_email: 'barbero@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'secret',
        ycloud_webhook_endpoint_id: 'endpoint-new',
        ycloud_webhook_secret: 'signing-secret-new',
      },
    })

    expect(createOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({ storefront_enabled: false }),
      expect.any(String), expect.any(String), expect.any(Number),
    )
  })

  // La ruta que se usa de verdad: encender la tienda de un negocio que ya
  // existe. Si el campo no está en la lista blanca de `ALLOWED_BUSINESS_FIELDS`
  // el panel guarda "con éxito" y no cambia nada — el fallo más molesto de
  // encontrar, porque no da ningún error.
  it('deja encender y apagar la tienda de un negocio existente', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Pizzería',
      plan: 'micro',
      whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001',
      ycloud_number: '+593999000001',
      ycloud_api_key: 'secret',
      ycloud_webhook_endpoint_id: 'endpoint',
      ycloud_webhook_secret: 'signing',
    })
    const updateBusiness = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })

    const encender = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { storefront_enabled: true },
    })

    expect(encender.status).toBe(200)
    expect(updateBusiness).toHaveBeenCalledWith(
      'business-a',
      expect.objectContaining({ storefront_enabled: true }),
    )

    updateBusiness.mockClear()
    await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'business-a' },
      body: { storefront_enabled: false },
    })
    expect(updateBusiness).toHaveBeenCalledWith(
      'business-a',
      expect.objectContaining({ storefront_enabled: false }),
    )
  })

  // ⚠️ TAMBIÉN AL REVÉS DESDE EL 2026-09-16. Antes esto exigía un 400: apagar
  // la tienda de un negocio en modo mini app lo dejaba «sin atención».
  //
  // Es exactamente el fallo que el dueño encontró en el panel: ocultar un local
  // del marketplace apaga pedidos y tienda, así que el guardado moría con «El
  // modo miniapp requiere que la tienda esté encendida». Se tapaba moviéndole
  // el `chat_mode` a 'menu' desde el modal —usar un modo de conversación para
  // esquivar una validación—, y eso murió con el modo menú.
  it('ocultar un local del marketplace se guarda, no se rechaza', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Pizzería',
      plan: 'micro',
      whatsapp_provider: 'ycloud',
      whatsapp_number: '+593999000001',
      ycloud_number: '+593999000001',
      ycloud_api_key: 'secret',
      ycloud_webhook_endpoint_id: 'endpoint',
      ycloud_webhook_secret: 'signing',
      chat_mode: 'miniapp',
      takes_orders: true,
      storefront_enabled: true,
    })
    // Con implementación: antes esta prueba esperaba un 400 y el espía nunca
    // llegaba a usarse. Ahora el guardado SÍ ocurre, y sin simularlo la ruta
    // sale a Supabase de verdad.
    const updateBusiness = vi.spyOn(db, 'updateBusiness')
      .mockResolvedValue({ data: { id: 'business-a' }, error: null })

    const response = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(),
      params: { id: 'business-a' },
      // Lo que manda el panel al poner «Aparece en el marketplace: No».
      body: { storefront_enabled: false, takes_orders: false },
    })

    expect(response.status).toBe(200)
    expect(updateBusiness).toHaveBeenCalledWith(
      'business-a',
      expect.objectContaining({ storefront_enabled: false, takes_orders: false }),
    )
    // Y sin tocar el modo: ya no hace falta moverlo para que esto pase.
    expect(updateBusiness.mock.calls[0]?.[1]).not.toHaveProperty('chat_mode')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LOS CAJONES DEL MENÚ (2026-09-17)
// ═══════════════════════════════════════════════════════════════════════════
//
// El cajón del chat salía del TIPO, y el tipo es uno: un local de comida
// típica que sirve almuerzo al mediodía y carta de noche vivía solo bajo
// «Almuerzos», y a las 7 de la tarde el cliente se iba creyendo que no había
// nada para él. Ahora el superadmin elige hasta tres cajones.
describe('cómo usa la gente el menú de Umbani', () => {
  it('devuelve el embudo, los cajones y las búsquedas', async () => {
    const usos = vi.spyOn(db, 'getMarketplaceUsage').mockResolvedValue({
      embudo: [{ paso: 'escribieron', orden: 1, clientes: 9 }],
      cajones: [{ code: 'almuerzos', label: 'Almuerzos', entradas: 5, eligieron: 2, abandonaron: 3 }],
      busquedas: [{ consulta: 'sushi de cangrejo', veces: 1, sin_nada: 1, entendido: 'Comida internacional' }],
    })
    const res = await dispatch('get', '/api/admin/marketplace-usage', {
      auth: authorization(), query: { dias: '30' },
    })
    expect(res.status).toBe(200)
    expect(usos).toHaveBeenCalledWith(30)
    expect(res.body.dias).toBe(30)
    expect(res.body.cajones[0].abandonaron).toBe(3)
  })

  it('sin días pedidos mira la última semana, y nunca más de 90', async () => {
    const usos = vi.spyOn(db, 'getMarketplaceUsage')
      .mockResolvedValue({ embudo: [], cajones: [], busquedas: [] })
    await dispatch('get', '/api/admin/marketplace-usage', { auth: authorization() })
    expect(usos).toHaveBeenCalledWith(7)
    await dispatch('get', '/api/admin/marketplace-usage', {
      auth: authorization(), query: { dias: '9999' },
    })
    expect(usos).toHaveBeenLastCalledWith(90)
  })
})

describe('en qué cajones del menú aparece un local', () => {
  // Con canal configurado: la edición valida el estado que quedará guardado, y
  // un negocio a medias se rechazaría antes de llegar a los cajones.
  const NEGOCIO_CON_CANAL = {
    id: 'biz-1', name: 'Doña Rosa', plan: 'micro', whatsapp_provider: 'ycloud',
    whatsapp_number: '+593900111222', ycloud_number: '+593900111222',
    ycloud_api_key: 'clave', ycloud_webhook_endpoint_id: 'endpoint',
    ycloud_webhook_secret: 'secreto',
  }

  it('ofrece la lista de cajones para elegir', async () => {
    vi.spyOn(db, 'getAllMarketplaceCategories').mockResolvedValue([
      { code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️' },
      { code: 'restaurantes', label: 'Comida típica y restaurantes', emoji: '🍲' },
    ])
    const res = await dispatch('get', '/api/admin/marketplace-categories', {
      auth: authorization(),
    })
    expect(res.status).toBe(200)
    expect(res.body.categories.map(c => c.code)).toEqual(['almuerzos', 'restaurantes'])
  })

  it('el detalle del local dice dónde aparece hoy', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ id: 'biz-1', name: 'Doña Rosa' })
    vi.spyOn(db, 'getClientUserByBusiness').mockResolvedValue({ email: 'a@b.c' })
    vi.spyOn(db, 'getBusinessMarketplaceCategories').mockResolvedValue([
      { code: 'restaurantes', principal: true },
      { code: 'almuerzos', principal: false },
    ])
    const res = await dispatch('get', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'biz-1' },
    })
    expect(res.status).toBe(200)
    expect(res.body.marketplace_categories).toEqual(['restaurantes', 'almuerzos'])
  })

  it('al editar, guarda los cajones elegidos con el primero como principal', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(NEGOCIO_CON_CANAL)
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
    const guardar = vi.spyOn(db, 'setBusinessMarketplaceCategories').mockResolvedValue(2)
    const res = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(),
      params: { id: 'biz-1' },
      body: { marketplace_categories: ['restaurantes', 'almuerzos'] },
    })
    expect(res.status).toBe(200)
    expect(guardar).toHaveBeenCalledWith('biz-1', ['restaurantes', 'almuerzos'])
  })

  it('un cajón que no existe se explica, no revienta', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(NEGOCIO_CON_CANAL)
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
    vi.spyOn(db, 'setBusinessMarketplaceCategories')
      .mockRejectedValue(new Error('Ese cajón del menú no existe'))
    const res = await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(),
      params: { id: 'biz-1' },
      body: { marketplace_categories: ['inventado'] },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('cajón')
  })

  it('sin la lista en el cuerpo no se toca nada: el tipo sigue mandando', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue(NEGOCIO_CON_CANAL)
    vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
    const guardar = vi.spyOn(db, 'setBusinessMarketplaceCategories').mockResolvedValue(0)
    await dispatch('put', '/api/admin/clients/:id', {
      auth: authorization(), params: { id: 'biz-1' }, body: { name: 'Otro nombre' },
    })
    expect(guardar).not.toHaveBeenCalled()
  })
})
