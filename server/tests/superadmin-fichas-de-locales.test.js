import { describe, expect, it, vi } from 'vitest'
import { prepararElEntorno, authorization, db, dispatch } from './superadmin-locales.mjs'

prepararElEntorno()

// La FICHA de un local que ya existe: editarla, el canal, el bot, los accesos y la tienda.
describe('las fichas de los locales del superadmin', () => {
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
