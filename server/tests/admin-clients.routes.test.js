import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepararElEntorno, clientsRouter, authorization, db, dispatch } from './superadmin-locales.mjs'

prepararElEntorno()

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
