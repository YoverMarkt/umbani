// El superadmin: las fichas de los locales — darlos de alta, editarlos, suspender,
// el bot, los accesos. Una sección del router de `admin-clients.routes.ts`, que las
// registra EN ORDEN.

import type { Router } from 'express'
import { getPlanDefinition, normalizePlanId } from '../../config/plans'
import { recordError } from '../../services/error-log'
import { validarCarta } from '../../services/carta-del-local'
import { prepTimeForBusinessType } from '../../services/business-templates'
import { slugLibre } from '../../lib/slug'
import { sanitizeBusinessForAdmin } from '../../services/secrets'
import { ALLOWED_BUSINESS_FIELDS, assertDatabaseResult, auth, bcrypt, cargarCartaDelLocal, channelConfigurationError, channelIdentifierFormatError, configuredText, configuredWhatsAppProvider, db, duplicateChannelMessage, errorMessage, guardarCajonesDelMenu, guardarCiudadDelLocal, MIN_PASSWORD_LENGTH, QUIEN_REPARTE, requestedPlan, revisarLaCooperativa, safeFailure, seedBusinessCatalog, usageLimitsForPlan, UUID_CIUDAD } from './comun'

export function registrarFichasDeLosLocales(router: Router): void {
  router.get('/api/admin/clients', auth.authAdmin, async (_req, res) => {
    res.json(await db.getAllBusinesses())
  })

  /**
   * Los cajones del menú del chat. Van TODOS los activos, también los vacíos:
   * el superadmin necesita ver el cajón sin locales para meter ahí el primero.
   */
  router.get('/api/admin/marketplace-categories', auth.authAdmin, async (_req, res) => {
    res.json({ categories: await db.getAllMarketplaceCategories() })
  })

  /**
   * Cómo usa la gente el menú de Umbani.
   *
   * Las tres preguntas del dueño —dónde se cae, qué cajón se abandona y qué
   * escribe— salen de `marketplace_events`, que se empezó a llenar el
   * 2026-09-18. Antes de esa fecha no hay nada: el registro no se puede
   * inventar hacia atrás, y la pantalla lo dice en vez de enseñar ceros.
   */
  router.get('/api/admin/marketplace-usage', auth.authAdmin, async (req, res) => {
    const dias = Math.min(Math.max(Number(req.query.dias) || 7, 1), 90)
    res.json({ dias, ...(await db.getMarketplaceUsage(dias)) })
  })

  router.get('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
    const business = await db.getBusinessById(req.params.id)
    if (!business) return res.status(404).json({ error: 'No encontrado' })
    const user = await db.getClientUserByBusiness(req.params.id)
    // Los cajones EFECTIVOS: los elegidos, o los que le da su tipo. Así el panel
    // enseña dónde aparece de verdad, no un campo vacío que engaña.
    // ⚠️ Si esto falla se DICE. Antes se tragaba el error y el panel enseñaba
    // «sin elegir» a un local que sí tenía sus cajones: el fallo era invisible
    // salvo mirando la base a mano, que es justo como se encontró.
    const cajones = await db.getBusinessMarketplaceCategories(req.params.id)
      .catch((error: unknown) => {
        console.error('❌ leer los cajones del menú:', errorMessage(error))
        void recordError({
          businessId: req.params.id,
          category: 'servidor',
          code: 'cajones-del-menu',
          message: errorMessage(error),
        })
        return []
      })
    res.json({
      ...sanitizeBusinessForAdmin(business),
      client_email: user?.email || '',
      marketplace_categories: cajones.map(cajon => cajon.code),
    })
  })

  router.post('/api/admin/clients', auth.authAdmin, async (req, res) => {
    const body = req.body as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const whatsappNumber = typeof body.whatsapp_number === 'string'
      ? body.whatsapp_number.trim()
      : ''
    // El número solo es obligatorio para quien tiene canal propio: el negocio
    // del marketplace se atiende por el número de la plataforma, y pedirle uno
    // suyo sería pedirle algo que la base le prohíbe tener.
    if (!name) {
      return res.status(400).json({ error: 'Nombre requerido' })
    }
    if (!whatsappNumber && configuredWhatsAppProvider(body) !== 'marketplace') {
      return res.status(400).json({ error: 'Nombre y número requeridos' })
    }
    // Un local del marketplace nace sin número de canal, así que el del dueño es
    // el único que tiene. Sin él nace incapaz de que su dueño lo alcance por
    // WhatsApp, y eso no se ve hasta que el dueño lo intenta.
    if (configuredWhatsAppProvider(body) === 'marketplace'
      && !configuredText(body.owner_phone)) {
      return res.status(400).json({
        error: 'El WhatsApp del dueño es obligatorio: es con lo que pide sus reportes',
      })
    }

    const clientEmail = typeof body.client_email === 'string'
      ? body.client_email.trim() || null
      : null
    const clientPassword = typeof body.client_password === 'string'
      ? body.client_password || null
      : null
    if (Boolean(clientEmail) !== Boolean(clientPassword)) {
      return res.status(400).json({ error: 'Email y password deben enviarse juntos' })
    }
    if (!clientEmail || !clientPassword) {
      return res.status(400).json({ error: 'Email y password del dueño son obligatorios' })
    }
    if (clientPassword && clientPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      })
    }
    const channelError = channelConfigurationError(body)
    if (channelError) return res.status(400).json({ error: channelError })
    const whatsappProvider = configuredWhatsAppProvider(body)
    if (!whatsappProvider) {
      return res.status(400).json({ error: 'Proveedor de mensajería no válido' })
    }
    const planDefinition = requestedPlan(body, 'micro')
    if (!planDefinition) {
      return res.status(400).json({ error: 'Selecciona uno de los seis planes disponibles' })
    }
    const usageLimits = usageLimitsForPlan(planDefinition)
    // La carta revisada se comprueba ANTES de crear nada: un precio que falta
    // se corrige en la pantalla, no deja un local a medio cargar.
    const carta = body.carta === undefined || body.carta === null ? null : validarCarta(body.carta)
    if (carta && !carta.ok) {
      return res.status(400).json({
        error: `La carta tiene cosas por corregir: ${carta.errores.slice(0, 3).join(' · ')}`,
        errores: carta.errores,
      })
    }

    try {
      // La dirección de su tienda. Sin sufijo salvo que otro negocio ya la use:
      // el `Date.now()` de antes lo ponía SIEMPRE, y dejaba enlaces del doble de
      // largos que en un WhatsApp se leen como spam.
      const slug = await slugLibre(
        name,
        async candidato => Boolean(await db.getBusinessBySlug(candidato)),
      )
      const businessPayload: Record<string, unknown> = {
        slug,
        name,
        type: body.type || 'negocio',
        // Nace con el tiempo de su tipo —una heladería en 10, un asadero en
        // 40— y desde ahí manda el dueño. Solo RECOMIENDA al crear, igual que
        // la plantilla de catálogo y las capacidades.
        prep_time_minutes: prepTimeForBusinessType(
          typeof body.type === 'string' ? body.type : null,
        ),
        whatsapp_number: whatsappNumber,
        whatsapp_provider: whatsappProvider,
        ycloud_api_key: body.ycloud_api_key,
        ycloud_number: body.ycloud_number,
        ycloud_webhook_endpoint_id: body.ycloud_webhook_endpoint_id,
        ycloud_webhook_secret: body.ycloud_webhook_secret,
        meta_token: body.meta_token,
        meta_phone_id: body.meta_phone_id,
        telegram_bot_token: body.telegram_bot_token || null,
        takes_orders: body.takes_orders !== false,
        // La tienda nace apagada salvo que se pida: encenderla sin catálogo
        // cargado le daría al cliente final una app vacía.
        storefront_enabled: body.storefront_enabled === true,
        // Todo local nace pidiendo por su mini app, y no hay nada que elegir:
        // es el único modo desde el 2026-09-16. Se manda explícito en vez de
        // dejarlo al defecto de la columna para que el alta por API cree
        // exactamente el mismo negocio que el panel.
        chat_mode: 'miniapp',
        owner_phone: body.owner_phone || null,
        plan: planDefinition.id,
        active: true,
        bot_active: true,
        suspended: false,
        notes: body.notes,
        monthly_contact_limit: usageLimits.monthly_contact_limit,
        monthly_outbound_message_limit:
          usageLimits.monthly_outbound_message_limit,
      }
      const passwordHash = clientPassword ? await bcrypt.hash(clientPassword, 10) : null
      const monthlyRate = planDefinition.monthlyRate
      const result = await db.createBusinessOnboarding(
        businessPayload,
        clientEmail,
        passwordHash,
        monthlyRate,
      )
      assertDatabaseResult(result, 'crear onboarding')
      const business = result.data
      if (!business) throw new Error('crear onboarding: respuesta vacía')
      Object.assign(business, usageLimits, { chat_mode: businessPayload.chat_mode })
      console.log(`💳 Cuota mensual automática para ${name} — $${monthlyRate}/mes`)
      // Con carta, la carta; sin ella, los productos de ejemplo de su tipo, como
      // siempre. Nunca las dos: «lo mejor, al momento de dar de alta un local»
      // es que lo real ocupe el sitio del ejemplo (el dueño, 2026-09-24).
      const cargaDeCarta = carta?.ok
        ? await cargarCartaDelLocal(business.id, carta.menu, name)
        : null
      if (!cargaDeCarta) {
        await seedBusinessCatalog(business.id, businessPayload.type as string, name)
      }
      // ⚠️ Después del alta y sin poder tumbarla, igual que la plantilla: el
      // negocio ya existe y es transaccional. Si los cajones vienen mal, se dice
      // en la respuesta y el local se queda con los de su tipo, que es un sitio
      // razonable — no un negocio a medio crear.
      const cajonesMal = await guardarCajonesDelMenu(business.id, body)
      if (cajonesMal) {
        console.error('❌ cajones del menú al crear:', cajonesMal)
      }
      const ciudadMal = await guardarCiudadDelLocal(business.id, body.city_id)
      if (!ciudadMal) business.city_id = String(body.city_id)
      const avisos = [
        cargaDeCarta && 'aviso' in cargaDeCarta ? cargaDeCarta.aviso : null,
        cajonesMal,
        ciudadMal,
      ].filter(Boolean)
      res.status(201).json({
        ...sanitizeBusinessForAdmin(business),
        ...(cargaDeCarta && 'resumen' in cargaDeCarta ? { carta: cargaDeCarta.resumen } : {}),
        ...(avisos.length ? { aviso: avisos.join(' · ') } : {}),
      })
    } catch (error) {
      const duplicated = duplicateChannelMessage(error)
      if (duplicated) {
        console.error('❌ crear el cliente:', errorMessage(error))
        return res.status(409).json({ error: duplicated })
      }
      safeFailure(res, 'crear el cliente', error)
    }
  })

  router.put('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
    const body = req.body as Record<string, unknown>
    const identifierError = channelIdentifierFormatError(body)
    if (identifierError) return res.status(400).json({ error: identifierError })
    if ('whatsapp_provider' in body && !configuredWhatsAppProvider(body)) {
      return res.status(400).json({ error: 'Proveedor de mensajería no válido' })
    }
    if ('plan' in body && !normalizePlanId(body.plan)) {
      return res.status(400).json({ error: 'Selecciona uno de los seis planes disponibles' })
    }
    if ('delivery_by' in body && !QUIEN_REPARTE.includes(String(body.delivery_by))) {
      return res.status(400).json({ error: 'Quién reparte: el local, Umbani o una cooperativa' })
    }
    // Un «true» en texto o un 1 no se adivinan: decide quién lleva la comida.
    if ('own_fleet' in body && typeof body.own_fleet !== 'boolean') {
      return res.status(400).json({ error: 'Repartidores propios: encendido o apagado' })
    }
    // La ciudad: una que exista, o ninguna (el local deja de aparecer).
    if ('city_id' in body) {
      const ciudad = body.city_id === '' || body.city_id == null ? null : String(body.city_id)
      if (ciudad !== null && (!UUID_CIUDAD.test(ciudad) || !(await db.getCity(ciudad)))) {
        return res.status(400).json({ error: 'Ciudad no válida' })
      }
      body.city_id = ciudad
    }
    // Apagado, pruebas o producción; nada más. El CHECK de la base lo repite.
    if ('card_mode' in body) {
      const modo = body.card_mode === '' ? null : body.card_mode
      if (modo !== null && modo !== 'pruebas' && modo !== 'produccion') {
        return res.status(400).json({ error: 'Modo de cobro con tarjeta no válido' })
      }
      body.card_mode = modo
    }
    if (typeof body.client_password === 'string' && body.client_password
      && body.client_password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      })
    }
    const businessData: Record<string, unknown> = {}
    for (const field of ALLOWED_BUSINESS_FIELDS) {
      if (field in body) businessData[field] = body[field]
    }
    if ('whatsapp_provider' in businessData) {
      businessData.whatsapp_provider = configuredWhatsAppProvider(body)
    }
    // Los identificadores de canal se guardan como NULL cuando llegan vacíos.
    //
    // ⚠️ `whatsapp_number` es UNIQUE. Guardando la cadena vacía, el PRIMER
    // negocio convertido a marketplace se guardaría y el SEGUNDO chocaría contra
    // el índice único — y el mensaje diría «ese número ya está asignado a otro
    // negocio» sobre un negocio que no tiene número. El alta ya lo evita dentro
    // de la RPC; la edición no pasa por ella, y convertir un negocio existente
    // es justo el camino esperado al montar el marketplace.
    for (const field of ['whatsapp_number', 'ycloud_number', 'meta_phone_id'] as const) {
      if (field in businessData && typeof businessData[field] === 'string'
        && !String(businessData[field]).trim()) {
        businessData[field] = null
      }
    }

    try {
      const existingBusiness = await db.getBusinessById(req.params.id)
      if (!existingBusiness) return res.status(404).json({ error: 'No encontrado' })
      const cooperativaMal = await revisarLaCooperativa(body, existingBusiness)
      if (cooperativaMal) return res.status(400).json({ error: cooperativaMal })
      // ⚠️ Lo que se guarda ya estaba armado: la cooperativa revisada (o soltada,
      // al volver a «el local» o «Umbani») tiene que llegar también ahí. Sin
      // esto, volver a Umbani chocaba con el CHECK de la base. Lo cazó su prueba.
      if ('cooperative_id' in body) businessData.cooperative_id = body.cooperative_id

      const currentPlanId = normalizePlanId(existingBusiness.plan)
      const nextPlan = 'plan' in body
        ? getPlanDefinition(body.plan)
        : null
      const planChanged = Boolean(nextPlan && (
        nextPlan.id !== currentPlanId || body.apply_plan_defaults === true
      ))
      if (nextPlan) {
        // El cambio financiero se ejecuta después en una sola RPC junto con las
        // cuotas. Los aliases antiguos sí pueden normalizarse sin tocar importes.
        if (!planChanged && existingBusiness.plan !== nextPlan.id) {
          businessData.plan = nextPlan.id
        } else {
          delete businessData.plan
        }
      }

      // Una edición puede conservar secretos que el navegador nunca recibe.
      // Validamos el estado que realmente quedará guardado, no solo el fragmento
      // enviado por el formulario.
      const effectiveBusiness: Record<string, unknown> = {
        ...existingBusiness,
        ...businessData,
      }
      if (!('whatsapp_provider' in businessData)
        && !configuredText(existingBusiness.whatsapp_provider)) {
        effectiveBusiness.whatsapp_provider = 'ycloud'
      }
      const channelError = channelConfigurationError(effectiveBusiness)
      if (channelError) return res.status(400).json({ error: channelError })

      if (Object.keys(businessData).length) {
        const result = await db.updateBusiness(req.params.id, businessData)
        assertDatabaseResult(result, 'actualizar negocio')
      }

      if (planChanged && nextPlan) {
        assertDatabaseResult(
          await db.updateBusinessPlanBilling(
            req.params.id,
            nextPlan.id,
            nextPlan.monthlyRate,
            nextPlan.monthlyContactLimit,
            nextPlan.monthlyOutboundMessageLimit,
          ),
          'actualizar plan y facturación',
        )
      }

      if (typeof body.client_email === 'string' && body.client_email) {
        const passwordHash = typeof body.client_password === 'string' && body.client_password
          ? await bcrypt.hash(body.client_password, 10)
          : null
        assertDatabaseResult(
          await db.updateClientUser(req.params.id, body.client_email, passwordHash),
          'actualizar usuario cliente',
        )
      }

      const cajonesMal = await guardarCajonesDelMenu(req.params.id, body)
      if (cajonesMal) return res.status(400).json({ error: cajonesMal })

      res.json({ ok: true })
    } catch (error) {
      const duplicated = duplicateChannelMessage(error)
      if (duplicated) {
        console.error('❌ actualizar el cliente:', errorMessage(error))
        return res.status(409).json({ error: duplicated })
      }
      safeFailure(res, 'actualizar el cliente', error)
    }
  })

  router.delete('/api/admin/clients/:id', auth.authAdmin, async (req, res) => {
    try {
      assertDatabaseResult(await db.deleteBusiness(req.params.id), 'eliminar negocio')
      console.log(`🗑️ Cliente eliminado: ${req.params.id}`)
      res.json({ ok: true })
    } catch (error) {
      safeFailure(res, 'eliminar el cliente', error)
    }
  })

  router.post('/api/admin/clients/:id/suspend', auth.authAdmin, async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason
      ? req.body.reason
      : 'Pago pendiente'
    try {
      assertDatabaseResult(await db.suspendBusiness(req.params.id, reason), 'suspender negocio')
      res.json({ ok: true })
    } catch (error) {
      safeFailure(res, 'suspender el cliente', error)
    }
  })

  // Interruptor operativo del bot, aparte de la edición del negocio.
  //
  // Va por su propia ruta y no por el PUT a propósito: ese valida el canal
  // ENTERO antes de guardar, así que pausar el bot de un negocio con
  // credenciales incompletas fallaría pidiendo el Signing Secret de YCloud —
  // justo cuando más falta hace poder pausarlo. Mismo motivo por el que
  // suspender y reactivar tienen las suyas.
  router.post('/api/admin/clients/:id/bot', auth.authAdmin, async (req, res) => {
    const { active } = req.body as { active?: unknown }
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active debe ser true o false' })
    }
    try {
      const business = await db.getBusinessById(req.params.id)
      if (!business) return res.status(404).json({ error: 'No encontrado' })
      // Un negocio suspendido responde el aviso de pago y nunca llega al bot:
      // encenderlo aquí dejaría el panel diciendo una cosa y la realidad otra.
      if (active && business.suspended) {
        return res.status(409).json({ error: 'Reactiva el negocio antes de encender su bot' })
      }
      assertDatabaseResult(await db.setBotActive(req.params.id, active), 'cambiar estado del bot')
      res.json({ ok: true, bot_active: active })
    } catch (error) {
      safeFailure(res, 'cambiar el estado del bot', error)
    }
  })

  router.post('/api/admin/clients/:id/reactivate', auth.authAdmin, async (req, res) => {
    try {
      assertDatabaseResult(await db.reactivateBusiness(req.params.id), 'reactivar negocio')
      res.json({ ok: true })
    } catch (error) {
      safeFailure(res, 'reactivar el cliente', error)
    }
  })

  router.post('/api/admin/clients/:id/create-user', auth.authAdmin, async (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown }
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email y password requeridos' })
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`,
      })
    }
    try {
      const passwordHash = await bcrypt.hash(password, 10)
      assertDatabaseResult(await db.createClientUser({
        business_id: req.params.id,
        email,
        password_hash: passwordHash,
      }), 'crear usuario cliente')
      res.json({ ok: true })
    } catch (error) {
      safeFailure(res, 'crear el usuario cliente', error)
    }
  })

  router.get('/api/admin/clients/:id/products', auth.authAdmin, async (req, res) => {
    res.json(await db.getProducts(req.params.id))
  })

  router.get('/api/admin/clients/:id/conversations', auth.authAdmin, async (req, res) => {
    res.json(await db.getConversations(req.params.id))
  })

  // ⚠️ Aquí vivían `GET/PUT /api/admin/clients/:id/policies`, retiradas el
  // 2026-09-20 con la pantalla «Bienvenida»: el saludo no lo leía nadie.
}
