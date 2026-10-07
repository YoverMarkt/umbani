import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepararElEntorno, authorization, bcrypt, db, dispatch } from './superadmin-locales.mjs'

prepararElEntorno()

// El ALTA de un local desde el superadmin: la carta revisada, los datos que se
// piden, los que se rechazan y los secretos que nunca vuelven.
describe('el alta de locales del superadmin', () => {
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
    const CHONE = '11111111-2222-4333-8444-555555555555'
    // La ciudad se guarda después del alta (2026-10-05): sin simularla, la
    // consulta iría a la base de verdad y la prueba se quedaría esperando.
    beforeEach(() => {
      vi.spyOn(db, 'getCity').mockResolvedValue({ id: CHONE, name: 'Chone', active: true })
      vi.spyOn(db, 'updateBusiness').mockResolvedValue({ data: null, error: null })
    })
    const altaCon = carta => dispatch('post', '/api/admin/clients', {
      auth: authorization(),
      body: {
        name: 'La Abuelita 2', whatsapp_number: '+593999000010', type: 'almuerzos',
        client_email: 'abuelita@example.com', client_password: 'safe-password-12',
        ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
        carta, city_id: CHONE,
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
      const ciudad = db.updateBusiness
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
      // Y su ciudad, después del alta (2026-10-05): sin ella no aparece a nadie.
      expect(ciudad).toHaveBeenCalledWith('business-carta', { city_id: CHONE })
    })

    it('un local dado de alta SIN ciudad se crea, pero se avisa de que no aparecerá', async () => {
      vi.spyOn(db, 'createBusinessOnboarding').mockResolvedValue({
        data: { id: 'business-sin-ciudad', name: 'La Abuelita 2' }, error: null,
      })
      vi.spyOn(db, 'applyBusinessMenu').mockResolvedValue({
        data: { aplicada: true, categorias: 1, listas: 0, productos: 1, grupos: 1, opciones: 2, variantes: 0 },
        error: null,
      })
      const respuesta = await dispatch('post', '/api/admin/clients', {
        auth: authorization(),
        body: {
          name: 'La Abuelita 2', whatsapp_number: '+593999000010', type: 'almuerzos',
          client_email: 'abuelita@example.com', client_password: 'safe-password-12',
          ycloud_api_key: 'k', ycloud_webhook_endpoint_id: 'e', ycloud_webhook_secret: 's',
          carta: cartaRevisada,
        },
      })
      expect(respuesta.status).toBe(201)
      expect(respuesta.body.aviso).toMatch(/Sin ciudad/)
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
})
