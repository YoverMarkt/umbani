import rateLimit from 'express-rate-limit'
import multer from 'multer'
import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { conOpcionesAgrupadas } from '../services/order-detail'
import type { ScheduleRecord } from '../db/types'
import { MEDIA_LIMITS, mapMulterError, validateMediaFile } from '../lib/media'
import { isConfigured, uploadPrivateMedia } from '../integrations/cloudinary'
import {
  readStorefrontBlock, readStorefrontSession, readToken, requireStorefrontSession,
} from '../middleware/storefront'
import { getPlatformPhone } from '../services/platform-channel'
import { pedirComprobantePorChat } from '../services/payment-request-notice'
import { checkSession, deviceFingerprint, hashToken, phoneMatchesSession } from '../services/storefront-session'
import {
  buildStorefrontCatalog,
  canOrder,
  quoteCart,
  reglaDeMargen,
  publicBusiness,
  storefrontStatus,
  type StorefrontBusiness,
} from '../services/storefront'
import { avisarAlDuenoDelPedido } from '../services/owner-order-notice'
import { metodoTarjeta, pagosConTarjeta, tarjetaDisponible } from '../services/pago-con-tarjeta'
import { leerConfiguracionPayphone } from '../config/payphone'

// Rutas de la mini app del negocio.
//
// ⚠️ SON PÚBLICAS: no hay JWT. La credencial es el enlace que mandó el bot, y
// la valida `requireStorefrontSession`. Todo lo que no sea la portada exige
// sesión, y la portada no revela nada que no esté ya en el WhatsApp del local.
//
// El precio JAMÁS llega del cliente: la app manda ids y cantidades, y la RPC
// resuelve cada importe desde la base (regla inviolable #8).

/** La fila de sesión, con lo que necesitan la redirección y la verificación. */
interface StorefrontSessionRow {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  expires_at: string | null
  revoked_at: string | null
  verified_at?: string | null
}

interface StorefrontRouteDatabase {
  /** La regla de margen vigente del negocio, o null si no hay ninguna. */
  getBusinessPricingRule(businessId: string): Promise<Record<string, unknown> | null>
  getStorefrontPaymentMethods(businessId: string): Promise<Array<{
    code: string
    label: string
    help_text: string | null
    is_prepaid: boolean
    requires_proof: boolean
  }>>
  getBusinessBySlug(slug: string): Promise<StorefrontBusiness | null>
  /** Lo mínimo del pedido para cuadrar su comprobante: cuánto, cuándo y de quién. */
  getOrderForReceiptCheck(businessId: string, orderId: string): Promise<{
    total?: unknown
    created_at?: string | null
    contact_name?: string | null
  } | null>
  getBusinessById(businessId: string): Promise<{ slug?: string | null; name?: string | null } | null>
  getStorefrontSessionByHash(tokenHash: string): Promise<StorefrontSessionRow | null>
  bindStorefrontSession(sessionId: string, deviceHash: string): Promise<boolean>
  /** El bloqueo del dueño es total: quien está bloqueado no puede pedir. */
  isCustomerBlocked(businessId: string, customerId: string): Promise<boolean>
  getSchedule(businessId: string): Promise<ScheduleRecord[]>
  getStorefrontCategories(businessId: string): Promise<unknown[]>
  getStorefrontProducts(businessId: string): Promise<unknown[]>
  getStorefrontVariants(businessId: string): Promise<unknown[]>
  getStorefrontExtras(businessId: string): Promise<unknown[]>
  getStorefrontOptionGroups(businessId: string): Promise<unknown[]>
  getStorefrontOptions(businessId: string): Promise<unknown[]>
  getStorefrontRecommendations(businessId: string): Promise<unknown[]>
  getBusinessBankAccount(businessId: string): Promise<unknown>
  getCustomerAddresses(businessId: string, customerId: string): Promise<unknown[]>
  createCustomerAddress(input: Record<string, unknown>): Promise<unknown>
  /** Devuelve `null` cuando la dirección no es de ese cliente y ese negocio. */
  deactivateCustomerAddress(input: {
    businessId: string
    customerId: string
    addressId: string
  }): Promise<unknown>
  setCustomerAddressLocation(input: {
    businessId: string
    customerId: string
    addressId: string
    latitude: number
    longitude: number
    accuracyM: number | null
  }): Promise<unknown>
  getBusinessCustomer(businessId: string, customerId: string): Promise<unknown>
  setCustomerDisplayName(
    businessId: string,
    customerId: string,
    name: string,
  ): Promise<{ error: unknown }>
  /**
   * El dinero OFICIAL del pedido, leído de la fila ya sellada por el
   * disparador. Y su estado: la RPC no lo devuelve, y sin él no se sabe si
   * hay que pedir el comprobante por el chat.
   */
  getOrderMoney(businessId: string, orderId: string): Promise<{
    subtotal: number | string | null
    shipping: number | string | null
    total: number | string | null
    status: string | null
    payment_method: string | null
  } | null>
  /** El último intento de cobro con tarjeta de UN pedido de ESTE negocio. */
  getLatestCardPayment(businessId: string, orderId: string): Promise<{
    status: string
    card_brand: string | null
    card_last_digits: string | null
  } | null>
  createStorefrontOrder(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
  getStorefrontOrders(input: { businessId: string; contactPhone: string }): Promise<{
    data: unknown[] | null
    error: { message?: string } | null
  }>
  getStorefrontOrder(input: { businessId: string; contactPhone: string; orderId: string }): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
  attachStorefrontPaymentProof(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
}

const db: StorefrontRouteDatabase = require('../db') as typeof import('../db')
const schedule: {
  isOutsideHours(schedule: ScheduleRecord[] | null | undefined, now?: Date): boolean
  todaysHours(
    schedule: ScheduleRecord[] | null | undefined,
    now?: Date,
  ): { open: string; close: string; allDay?: boolean } | null
  proximaApertura(
    schedule: ScheduleRecord[] | null | undefined,
    now?: Date,
  ): { open: string; inDays: number; dayName: string } | null
} = require('../services/schedule') as typeof import('../services/schedule')

const router = createRouter()

// Un enlace legítimo no necesita 200 peticiones por minuto. Frena el raspado
// del catálogo y los intentos de probar tokens a lo bruto.
const storeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

// Crear pedidos es mucho más caro y nadie pide 30 veces por minuto.
/**
 * Los métodos que ESE local acepta, con la tarjeta si le toca.
 *
 * La tarjeta no vive en `business_payment_methods` —esa lista la edita el
 * dueño, y el dinero de la tarjeta entra en la cuenta de Umbani—, así que se
 * añade aquí cuando el superadmin la encendió y el servidor cobra en el mismo
 * modo (`tarjetaDisponible`). Si la consulta falla, lista vacía: el cliente
 * puede mirar la carta igual y el checkout lo vuelve a comprobar.
 */
async function metodosDeLaTienda(business: StorefrontBusiness) {
  const metodos = await db.getStorefrontPaymentMethods(business.id).catch(() => [])
  const config = leerConfiguracionPayphone()
  return config && tarjetaDisponible(business, config)
    ? [...metodos, metodoTarjeta(config)]
    : metodos
}

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de pedido, espera un momento' },
})

/**
 * El tope por ENLACE, que se suma al de IP.
 *
 * ⚠️ Los dos ejes son necesarios porque cada uno tapa el agujero del otro
 * (2026-09-06):
 *
 *   · Solo por IP —lo que había— falla en las dos direcciones con datos
 *     móviles. Muchos clientes salen por la MISMA IP del operador (CGNAT), así
 *     que uno que molesta se come el cupo de vecinos que no han hecho nada; y
 *     al revés, quien apaga y enciende los datos estrena IP y vuelve a tener
 *     el cupo entero. La dirección no identifica a nadie en un teléfono.
 *   · Solo por sesión no protege del que llega SIN enlace, que es quien puede
 *     raspar el catálogo público.
 *
 * Juntos, el que trae enlace responde por su enlace y el que no, por su IP.
 * Ninguno de los dos se esquiva cambiando de eje.
 *
 * ⚠️ La clave es el HASH del token, nunca el token: las claves del limitador
 * viven en memoria y se asoman en volcados y trazas. Es el mismo hash con el
 * que la sesión se busca en la base, así que «una clave» es exactamente «una
 * sesión».
 *
 * ⚠️ Más holgado que el de IP a propósito (60 < 90). Este cuenta a UNA persona
 * con su enlace; el de IP puede estar contando a varias a la vez, y estrecharlo
 * aquí castigaría al cliente legítimo que navega rápido.
 */
const sesionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Sin enlace no hay a quién contarle: de ese se ocupa `storeLimiter`.
  skip: (req) => !readToken(req),
  keyGenerator: (req) => `sesion:${hashToken(readToken(req))}`,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

router.use('/api/store', storeLimiter, sesionLimiter)
router.use('/s', storeLimiter)

// ── Enlace corto: /s/<token> ───────────────────────────────────────────────
//
// Lo que el bot manda por WhatsApp. Existe por una razón de producto, no
// técnica: el enlace completo medía unos 130 caracteres y en un chat eso se
// lee como spam. Aquí solo viaja el token, que ya identifica al negocio.
//
// No devuelve datos NUNCA, solo redirige — por eso no lleva sesión: quien
// llegue con un token inventado no averigua nada, y quien llegue con el suyo
// ya lo tenía. La sesión se sigue validando entera al pedir el catálogo.
router.get('/s/:code', async (req, res) => {
  const code = String(req.params.code || '').trim()
  if (code) {
    const session = await db.getStorefrontSessionByHash(hashToken(code)).catch(() => null)
    if (session?.business_id) {
      const business = await db.getBusinessById(session.business_id).catch(() => null)
      if (business?.slug) {
        // Se conserva el token en el destino: la tienda lo lee y lo borra de la
        // barra de direcciones.
        return res.redirect(
          302,
          `/t/${encodeURIComponent(business.slug)}?s=${encodeURIComponent(code)}`,
        )
      }
    }
  }
  // Token desconocido: la tienda explicará que hace falta pedir uno propio.
  return res.redirect(302, '/t/_')
})

const readStatus = async (business: StorefrontBusiness | null) => {
  if (!business?.id) {
    return { status: storefrontStatus({ business: null, outsideHours: false }), hours: null }
  }
  const businessSchedule = await db.getSchedule(business.id).catch(() => [])
  const outsideHours = schedule.isOutsideHours(businessSchedule || [])
  return {
    status: storefrontStatus({ business, outsideHours }),
    outsideHours,
    // El horario vigente, para la píldora de la portada. Va junto al estado y
    // no dentro del negocio porque depende de QUÉ HORA ES, no de quién es.
    hours: schedule.todaysHours(businessSchedule || []),
    // ⚠️ Y CUÁNDO VUELVE A ABRIR, que es lo único que le importa a quien llega
    // con la tienda cerrada (2026-09-02). El rango del día a secas hacía que
    // «Cerrado · 8:00 AM – 2:00 AM» se leyera a la 01:10 como un error de la
    // app. Es `null` mientras está abierta: ahí no hay nada que anunciar.
    nextOpen: schedule.proximaApertura(businessSchedule || []),
  }
}

// ── Portada: lo único que se ve sin enlace ─────────────────────────────────
// Quien reciba un enlace reenviado cae aquí: ve el nombre del negocio y su
// WhatsApp para pedir el suyo. Nada más: ni catálogo, ni precios, ni clientes.
router.get('/api/store/:slug', readStorefrontBlock, async (req, res) => {
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status, hours, nextOpen } = await readStatus(business)
  if (!business?.id || status === 'no_disponible') {
    return res.status(404).json({ error: 'Esta tienda no está disponible' })
  }
  return res.json({
    /**
     * ⚠️ La portada es la ÚNICA pantalla que recibe un bloqueado, y lleva
     * `blocked` para que la app lo sepa ANTES de montar la tienda.
     *
     * El 2026-08-29 el dueño, bloqueado, abrió un enlace viejo, recorrió la
     * carta entera y creó el pedido #74. La app no tenía forma de saberlo: se
     * enteraba —como mucho— al confirmar. Aquí se entera en la primera
     * petición, y pinta el aviso en vez del catálogo.
     *
     * ⚠️ Va con el nombre y el logo del local (lo de siempre) y NADA
     * accionable: ni carta, ni precios, ni checkout. Eso lo rechaza el 403 de
     * `readStorefrontSession` y, en último término, el disparador de la base.
     */
    blocked: req.storefrontBlock
      ? {
        until: req.storefrontBlock.until,
        permanent: req.storefrontBlock.permanent,
      }
      : null,
    /**
     * ⚠️ El enlace con el que se abrió ya no vale (revocado o caducado).
     *
     * La app lo mira ANTES de montar la tienda, igual que `blocked`, y pinta
     * «Tu enlace expiró» en vez de la carta. Si se enterara al pedir la carta,
     * la tienda ya estaría montada y el aviso saldría encima de un menú vacío.
     */
    expired: req.storefrontExpired === true,
    business: {
      // ⚠️ `catch(() => null)`: sin el número del marketplace la tienda abre
      // igual, solo que sin los botones de WhatsApp. Que un fallo leyendo
      // `server_settings` tumbe la PORTADA sería cambiar cuatro botones por
      // una tienda que no carga.
      ...publicBusiness(business, null, await getPlatformPhone().catch(() => null)),
      // Los métodos que ESE local acepta. La app los pinta; ya no los lleva
      // escritos a mano. Si la consulta falla se manda una lista vacía en vez
      // de romper la portada: el cliente puede mirar la carta igual, y el
      // checkout lo volverá a comprobar contra la base.
      paymentMethods: await metodosDeLaTienda(business),
    },
    status,
    canOrder: canOrder(status),
    todaysHours: hours,
    nextOpen,
  })
})

// ── Confirmar el número: la puerta del enlace ──────────────────────────────
//
// El enlace ya no caduca, así que lo que lo protege es esto: para usarlo hay
// que saber a qué número de WhatsApp se emitió.
//
// Antes bastaba con abrirlo primero. Quien reenviaba el enlace ANTES de
// abrirlo se lo regalaba al primero que hiciera clic, y el cliente legítimo se
// quedaba fuera de su propia tienda.
//
// NO lleva `requireStorefrontSession` a propósito: ese middleware rechaza
// justo el estado en el que se llega aquí (`necesita_telefono`).
const verifyLimiter = rateLimit({
  // Mucho más estrecho que el resto de la tienda: aquí se adivinan teléfonos.
  // Ocho intentos por minuto bastan para quien se equivoca escribiendo y no
  // para quien prueba números en serie.
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, espera un momento' },
})

router.post('/api/store/:slug/session/verify', verifyLimiter, async (req, res) => {
  const token = String(
    req.headers['x-storefront-token']
    || (req.body as { token?: unknown } | null)?.token
    || '',
  ).trim()
  const telefono = String((req.body as { phone?: unknown } | null)?.phone || '').trim()
  if (!token || !telefono) {
    return res.status(400).json({ error: 'Falta el número' })
  }

  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  if (!business?.id) return res.status(404).json({ error: 'Esta tienda no está disponible' })

  const session = await db.getStorefrontSessionByHash(hashToken(token))
  const veredicto = checkSession({
    session: session as never,
    deviceHash: '',
    expectedBusinessId: business.id,
  })
  // Solo se sigue si lo único que falta es el número. Una sesión revocada, de
  // otro negocio o inexistente se rechaza igual que en el resto de la tienda.
  if (!veredicto.session || (veredicto.reason && veredicto.reason !== 'necesita_telefono')) {
    return res.status(401).json({ error: 'Este enlace no es válido', reason: veredicto.reason })
  }

  if (!phoneMatchesSession(veredicto.session.contact_phone, telefono)) {
    // Mismo texto para "no coincide" que para "no existe": quien prueba
    // números no debe poder distinguir un fallo de otro.
    return res.status(401).json({
      error: 'Ese número no coincide con este enlace',
      reason: 'necesita_telefono',
    })
  }

  const deviceHash = deviceFingerprint({
    clientId: typeof req.headers['x-storefront-device'] === 'string'
      ? req.headers['x-storefront-device']
      : '',
    userAgent: req.headers['user-agent'] || '',
    acceptLanguage: req.headers['accept-language'] || '',
  })
  const atada = await db.bindStorefrontSession(veredicto.session.id, deviceHash)
  if (!atada) return res.status(500).json({ error: 'No pudimos confirmar tu número' })

  return res.json({ ok: true })
})

// ── De aquí en adelante hace falta el enlace ───────────────────────────────

// ── El catálogo es PÚBLICO ─────────────────────────────────────────────────
// Un enlace de comida se reenvía, se pega en una historia y se busca: quien
// llegue tiene que poder ver la carta y los precios sin identificarse, como en
// cualquier tienda. Pedir sigue exigiendo el enlace del bot.
//
// Solo salen columnas ya elegidas a mano en `db/repositories/catalog.ts` — sin
// embeddings, sin SKU, sin nada interno—, y el negocio pasa por
// `publicBusiness`, que es el mismo saneo que ya usaba la portada.
router.get('/api/store/:slug/catalog', readStorefrontSession, async (req, res) => {
  const businessId = req.storeBusinessId!
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status, hours, nextOpen } = await readStatus(business)

  const [
    categories, products, variants, extras, optionGroups, options, recommendations,
  ] = await Promise.all([
    db.getStorefrontCategories(businessId),
    db.getStorefrontProducts(businessId),
    db.getStorefrontVariants(businessId),
    db.getStorefrontExtras(businessId),
    db.getStorefrontOptionGroups(businessId),
    db.getStorefrontOptions(businessId),
    db.getStorefrontRecommendations(businessId),
  ])

  // ⚠️ La regla se consulta UNA vez por catálogo, no por producto: es del
  // negocio, no de cada plato. Falla hacia `null` —sin margen—, que es el lado
  // seguro: el cliente vería el precio del comercio, nunca uno inflado por un
  // error de lectura.
  const pricing = reglaDeMargen(
    await db.getBusinessPricingRule(businessId).catch(() => null),
  )

  // ── El catálogo se puede guardar UNOS SEGUNDOS ────────────────────────
  //
  // Es la petición más cara de la app: 13 consultas y ~2 s de espera medidos
  // contra producción el 2026-09-06. Y su contenido es el MISMO para todo el
  // que mira este local — no lleva ni una línea del cliente que pregunta.
  //
  // ⚠️ `private`, NO `public`, y la diferencia es una defensa. Con `public`,
  // un proxy compartido podría guardarse este 200 y servírselo después a
  // alguien BLOQUEADO, que debe recibir el 403 de `readStorefrontSession`. El
  // navegador de cada cliente sí lo guarda —que es de donde sale la mejora
  // real, porque hoy no hay CDN delante— y ningún intermediario puede repartir
  // la carta a quien el local no quiere atender.
  //
  // ⚠️ `Vary` sobre la cabecera de sesión: si algún día esto pasara a `public`,
  // dos personas con enlaces distintos no compartirían entrada de caché. Es
  // barato ahora y evita que ese cambio futuro sea silenciosamente inseguro.
  //
  // ⚠️ 30 s, no más: el `status` de abierto/cerrado y los precios viajan aquí.
  // Medio minuto de desfase no le cambia nada a nadie —y el dinero lo revalida
  // `create_storefront_order` contra la base, nunca este JSON—, pero un TTL
  // largo dejaría a un local recién abierto pareciendo cerrado.
  res.setHeader('Cache-Control', 'private, max-age=30, stale-while-revalidate=120')
  res.setHeader('Vary', 'x-storefront-token')

  return res.json({
    business: business
      ? {
        ...publicBusiness(business, pricing, await getPlatformPhone().catch(() => null)),
        paymentMethods: await metodosDeLaTienda(business),
      }
      : null,
    status,
    canOrder: canOrder(status),
    todaysHours: hours,
    nextOpen,
    ...buildStorefrontCatalog({
      categories: categories as never,
      products: products as never,
      variants: variants as never,
      extras: extras as never,
      optionGroups: optionGroups as never,
      options: options as never,
      recommendations: recommendations as never,
      pricing,
    }),
  })
})

/** Quién es el cliente y qué direcciones tiene guardadas EN ESTE negocio. */
router.get('/api/store/:slug/me', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId, contactPhone } = req.storefront!
  const [addresses, relation] = await Promise.all([
    db.getCustomerAddresses(businessId, customerId),
    db.getBusinessCustomer(businessId, customerId),
  ])
  return res.json({
    // Se devuelve enmascarado: la app solo necesita confirmar "a nombre de…".
    phone: `•••• ${contactPhone.slice(-4)}`,
    name: (relation as { display_name?: string } | null)?.display_name || null,
    addresses,
  })
})

// ── El pin y lo que necesita quien reparte ─────────────────────────────────
//
// Estos saneos repiten a propósito los CHECK de `customer_addresses`. No es
// desconfianza de la base —ella es la que manda— sino que el cliente lea «la
// ubicación no es válida» en vez de un error de restricción de PostgreSQL.

const TIPOS_DE_EDIFICIO = new Set(['casa', 'departamento', 'oficina', 'hotel', 'otro'])

interface Ubicacion { latitude: number; longitude: number; accuracyM: number | null }

/**
 * Lee el pin del cuerpo de la petición.
 *
 * Devuelve `null` cuando no se mandó ninguno —el pin es OPCIONAL: quien niega
 * el permiso del navegador tiene que poder pedir igual— y un error solo cuando
 * lo mandado no sirve.
 *
 * ⚠️ Latitud y longitud viajan JUNTAS o no viajan. Media coordenada no es medio
 * pin: es un punto en el ecuador o en Greenwich, que es peor que no tener nada
 * porque parece un dato.
 */
const leerUbicacion = (
  body: Record<string, unknown>,
): { ok: true; valor: Ubicacion | null } | { ok: false; error: string } => {
  const crudaLat = body.latitude
  const crudaLng = body.longitude
  const vacia = (v: unknown) => v === undefined || v === null || v === ''
  if (vacia(crudaLat) && vacia(crudaLng)) return { ok: true, valor: null }
  if (vacia(crudaLat) || vacia(crudaLng)) {
    return { ok: false, error: 'La ubicación llegó incompleta' }
  }

  const latitude = Number(crudaLat)
  const longitude = Number(crudaLng)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { ok: false, error: 'La ubicación no es válida' }
  }

  // La precisión es opcional y solo informativa: si llega rara se descarta en
  // vez de rechazar el pin, que es el dato que de verdad importa.
  const cruda = Number(body.accuracy)
  const accuracyM = Number.isFinite(cruda) && cruda >= 0 && cruda <= 100000
    ? Math.round(cruda * 10) / 10
    : null

  return { ok: true, valor: { latitude, longitude, accuracyM } }
}

router.post('/api/store/:slug/addresses', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId } = req.storefront!
  const body = (req.body || {}) as Record<string, unknown>
  const address = String(body.address || '').trim()
  if (address.length < 5 || address.length > 300) {
    return res.status(400).json({ error: 'La dirección no es válida' })
  }

  const ubicacion = leerUbicacion(body)
  if (!ubicacion.ok) return res.status(400).json({ error: ubicacion.error })

  const tipo = String(body.buildingType || '').trim().toLowerCase()
  if (tipo && !TIPOS_DE_EDIFICIO.has(tipo)) {
    return res.status(400).json({ error: 'Ese tipo de edificio no existe' })
  }

  const created = await db.createCustomerAddress({
    businessId,
    customerId,
    label: String(body.label || 'Casa').slice(0, 40),
    address,
    reference: String(body.reference || '').slice(0, 300) || null,
    latitude: ubicacion.valor?.latitude ?? null,
    longitude: ubicacion.valor?.longitude ?? null,
    accuracyM: ubicacion.valor?.accuracyM ?? null,
    buildingType: tipo || null,
    courierNotes: String(body.courierNotes || '').trim().slice(0, 300) || null,
    isDefault: body.isDefault === true,
  })
  return res.status(201).json(created)
})

/**
 * Retira una dirección de la libreta.
 *
 * Se marca inactiva, no se borra: `orders.address_id` apunta aquí y con él se
 * sabe a qué casa pide más un cliente. El destino de cada pedido ya va
 * congelado aparte, así que retirarla no deja ningún reparto sin dirección.
 */
router.delete('/api/store/:slug/addresses/:id', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId } = req.storefront!
  const retirada = await db.deactivateCustomerAddress({
    businessId,
    customerId,
    addressId: String(req.params.id || ''),
  })
  // No era suya, o ya estaba retirada. Se responde lo mismo en los dos casos:
  // decir «existe pero no es tuya» ya sería contar algo de otro cliente.
  if (!retirada) return res.status(404).json({ error: 'Esa dirección no existe' })
  return res.json({ ok: true })
})

/**
 * Le pone el pin a una dirección que ya estaba guardada.
 *
 * Sin esto, las direcciones de siempre —«7 de agosto», sin coordenadas— se
 * quedarían sin ubicación para siempre: el botón solo serviría al estrenar
 * dirección, y el cliente que ya tiene la suya es justo el que más pide.
 */
router.put('/api/store/:slug/addresses/:id/location', requireStorefrontSession, async (req, res) => {
  const { businessId, customerId } = req.storefront!
  const ubicacion = leerUbicacion((req.body || {}) as Record<string, unknown>)
  if (!ubicacion.ok) return res.status(400).json({ error: ubicacion.error })
  if (!ubicacion.valor) return res.status(400).json({ error: 'No llegó ninguna ubicación' })

  const actualizada = await db.setCustomerAddressLocation({
    businessId,
    customerId,
    addressId: String(req.params.id || ''),
    latitude: ubicacion.valor.latitude,
    longitude: ubicacion.valor.longitude,
    accuracyM: ubicacion.valor.accuracyM,
  })
  // No era suya, o no existe. Se responde lo mismo en los dos casos: decir
  // «existe pero no es tuya» ya sería contar algo de otro cliente.
  if (!actualizada) return res.status(404).json({ error: 'Esa dirección no existe' })
  return res.json(actualizada)
})

// ── Pedido ─────────────────────────────────────────────────────────────────
router.post('/api/store/:slug/orders', orderLimiter, requireStorefrontSession, async (req, res) => {
  const { businessId, customerId, contactPhone } = req.storefront!
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  const { status } = await readStatus(business)

  const body = (req.body || {}) as Record<string, unknown>

  // ── Bloqueado por el dueño: no pide, ni con su enlace ───────────────────
  //
  // El bloqueo del panel es TOTAL por decisión del dueño (2026-08-13): si solo
  // callara al bot, quien tenga su enlace guardado seguiría metiendo pedidos y
  // el bloqueo no bloquearía nada.
  //
  // Va aquí y no en el middleware a propósito: mirar la carta no molesta a
  // nadie, y comprobarlo en cada petición de catálogo sería pagar una consulta
  // por cada persona que abre la tienda para algo que le pasa a casi ninguna.
  // Lo que hay que impedir es que ENTRE un pedido, y eso pasa por aquí.
  //
  // El mensaje no dice «estás bloqueado»: quien molesta busca una reacción, y
  // el dueño no tiene por qué dar explicaciones desde una pantalla.
  if (await db.isCustomerBlocked(businessId, customerId).catch(() => false)) {
    return res.status(403).json({
      // ⚠️ Sin «comunícate con el local»: el cliente no tiene su número, y no
      // debe tenerlo. Se dice el hecho y nada más; la salida —los otros
      // locales— vive en la pantalla de bloqueado, no en un error de la API.
      error: 'Este local no está recibiendo tus pedidos ahora mismo.',
    })
  }

  // ── Cerrado: se puede mirar, no pedir ───────────────────────────────────
  //
  // La tienda solo acepta pedidos inmediatos. Los programados se retiraron el
  // 2026-08-07 por decisión del dueño: no están en el diagrama de referencia.
  // Con esto vuelve el comportamiento anterior — con el local cerrado no entra
  // ningún pedido, ni siquiera para más tarde.
  if (!canOrder(status)) {
    return res.status(409).json({
      error: status === 'cerrada'
        ? 'El negocio está cerrado ahora mismo'
        : 'Esta tienda no está recibiendo pedidos',
      status,
    })
  }

  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) {
    return res.status(400).json({ error: 'El pedido no tiene productos' })
  }

  // Se reconstruye la lista dejando fuera cualquier precio que mande la app:
  // aquí solo viajan ids y cantidades.
  const safeItems = items.slice(0, 50).map((raw) => {
    const item = (raw || {}) as Record<string, unknown>
    return {
      product_id: String(item.productId || item.product_id || ''),
      variant_id: String(item.variantId || item.variant_id || '') || null,
      extra_ids: (Array.isArray(item.extraIds) ? item.extraIds : [])
        .slice(0, 20)
        .map(id => String(id)),
      // Del motor de opciones solo pasa el id y cuántas porciones. El recargo,
      // el nombre y la validación de obligatorios salen de la base.
      options: (Array.isArray(item.options) ? item.options : [])
        .slice(0, 30)
        .map((raw) => {
          const opcion = (raw || {}) as Record<string, unknown>
          return {
            option_id: String(opcion.optionId || opcion.option_id || ''),
            quantity: Math.min(100, Math.max(1, Number(opcion.quantity) || 1)),
          }
        })
        .filter(opcion => opcion.option_id),
      quantity: Number(item.quantity) || 0,
      note: String(item.note || '').slice(0, 200) || null,
    }
  })

  const fulfillment = ['delivery', 'pickup', 'onsite'].includes(String(body.fulfillment))
    ? String(body.fulfillment)
    : null

  // «pago_al_retirar» no es cómo paga, es CUÁNDO: al pasar por el local. La
  // app solo lo ofrece en modo retiro, y aquí se vuelve a comprobar — una app
  // vieja, o alguien tocando la petición, no puede prometerle al negocio que
  // pasará a recoger un pedido que pidió a domicilio.
  //
  // ⚠️ La TARJETA (2026-09-27) solo si este local la tiene y el servidor cobra
  // en su mismo modo. Y si no, se RECHAZA: los demás métodos desconocidos se
  // convierten en «sin método», pero quien eligió tarjeta cree que va a pagar
  // con ella — un pedido creado sin método le haría esperar un cobro que no
  // existe.
  const metodoPedido = String(body.paymentMethod)
  if (metodoPedido === 'tarjeta' && !tarjetaDisponible(business)) {
    return res.status(409).json({ error: 'El pago con tarjeta no está disponible en este local ahora mismo' })
  }
  const metodoValido = ['transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta'].includes(metodoPedido)
    && !(metodoPedido === 'pago_al_retirar' && fulfillment === 'delivery')
  const paymentMethod = metodoValido ? metodoPedido : null

  const contactName = String(body.name || '').slice(0, 120) || null

  const result = await db.createStorefrontOrder({
    businessId,
    customerId,
    contactPhone,
    contactName,
    addressId: String(body.addressId || '') || null,
    fulfillment,
    paymentMethod,
    items: safeItems,
    // La app la genera al abrir el checkout y la repite si reintenta. Sin
    // clave el comportamiento es el de siempre: cada envío, un pedido.
    idempotencyKey: String(body.idempotencyKey || '').trim().slice(0, 100) || null,
    // El tope replica el CHECK de la base: un texto larguísimo acabaría en el
    // panel del dueño y en el reporte.
    deliveryNotes: String(body.deliveryNotes || '').trim().slice(0, 300) || null,
    // La tienda ya no programa (retirado el 2026-08-07). La RPC conserva el
    // parámetro y la columna `scheduled_for` sigue en la base: quitarlos
    // exigiría recrear la función del dinero por un campo que nadie llena.
    scheduledFor: null,
  })

  if (result.error) {
    // 42501 es pertenencia (producto ajeno, dirección de otro): no es un fallo
    // del servidor, es un pedido que no debía existir.
    const code = result.error.code === '42501' ? 403 : 400
    return res.status(code).json({ error: result.error.message || 'No se pudo crear el pedido' })
  }

  // El nombre se recuerda para el próximo pedido.
  //
  // Va DESPUÉS de crear el pedido y sin `await` que lo bloquee: es una
  // comodidad, no un requisito, y si la base la rechaza el cliente ya tiene su
  // pedido hecho. Antes esto no ocurría en ningún sitio —`ensureCustomer` lo
  // intenta con un `upsert` que la fila existente ignora—, así que la mini app
  // tenía la precarga construida y `display_name` en nulo tras 25 pedidos.
  if (contactName && contactName.trim().length >= 2) {
    void db.setCustomerDisplayName(businessId, customerId, contactName.trim())
      .catch(() => { /* el pedido ya está: recordar el nombre no puede fallarlo */ })
  }

  // ── El aviso al DUEÑO, si lo tiene encendido ────────────────────────────
  //
  // ⚠️ Nace APAGADO (`notify_owner_whatsapp`) y por eso esto casi siempre no
  // gasta nada: son dos mensajes por pedido y Meta los cobra. El dueño se
  // entera igual por la alarma del panel, que es gratis; esto es para quien
  // no lo tiene abierto.
  //
  // ⚠️ Sin `await`, como el resto de esta zona: el pedido YA está creado y el
  // cliente tiene que ver su confirmación ahora. Un proveedor externo lento no
  // puede retrasar la pantalla de «pedido recibido».
  //
  // ⚠️ Con TARJETA no: ese pedido todavía no existe para el local — no suena
  // su alarma ni avanza hasta que PayPhone confirma el cobro. El aviso sale
  // desde `pago-con-tarjeta.ts` en ese momento, cuando el dinero ya está.
  if (paymentMethod !== 'tarjeta') {
    void avisarAlDuenoDelPedido(businessId, (result.data as { id?: string } | null)?.id).catch(() => {
      /* el pedido ya está: un aviso de cortesía no puede tumbarlo */
    })
  }

  // ── El aviso que cierra el ciclo mini app → WhatsApp ─────────────────────
  //
  // Quien pide por la mini app está en un NAVEGADOR: a su WhatsApp no le llega
  // nada, y el comprobante tiene una sola vía desde el 2026-08-12, que es el
  // chat. Sin este mensaje cierra la pestaña para ir al banco y vuelve sin
  // ninguna conversación a la que responder con la foto.
  //
  // ⚠️ Solo si el pedido nació ESPERANDO PAGO. Un pedido en efectivo no debe
  // recibir una petición de transferencia; lo comprueba también el propio
  // aviso, pero preguntarlo aquí evita una consulta para casi todos.
  //
  // ⚠️ Sin `await`, igual que el nombre: el pedido YA está creado y el cliente
  // tiene que ver su confirmación ahora. Esperar a un proveedor externo antes
  // de responder cambiaría su tiempo por el de un mensaje — y si el canal
  // estuviera lento, le diría que su pedido falló cuando no falló.
  //
  // ⚠️ El estado se lee de la FILA, más abajo, y no de `result.data`: la RPC
  // no devuelve `status`. Preguntarle a ella daba siempre falso, y este aviso
  // no salió NI UNA VEZ en un mes (0 en la cola de producción, 2026-09-27).
  // La prueba lo daba por bueno porque llamaba a la función suelta con un
  // pedido inventado que sí traía el campo.

  // ── El total que se le devuelve al cliente sale de la FILA ──────────────
  //
  // ⚠️ No de lo que calculó la RPC. `create_storefront_order` devuelve su
  // propia cuenta (`subtotal + envío`), y el disparador `orders_stamp_pricing`
  // corre DESPUÉS: en modo `on_top` suma el margen de la plataforma al total.
  //
  // El efecto era de dinero, no de pintura: la pantalla de «pedido recibido»
  // enseñaba $12.99 —y ese es el número que el cliente copia para transferir—
  // sobre un pedido que la base guardaba en $14.09. Siete pedidos nacieron así
  // antes de que se viera; ninguno llegó a pagarse, pero el siguiente sí.
  //
  // Si la relectura fallara se devuelve lo que hay: el pedido está creado y
  // dejar al cliente sin confirmación por un total sería peor que un total
  // corto. Lo vigila la prueba de que los dos números coinciden.
  const creado = (result.data || {}) as Record<string, unknown>
  const oficial = await db.getOrderMoney(businessId, String(creado.id || ''))
  // ⚠️ Con tarjeta NO se pide comprobante: no hay transferencia que fotografiar.
  if (oficial?.status === 'esperando_pago' && oficial.payment_method !== 'tarjeta') {
    void pedirComprobantePorChat(businessId, String(creado.id || ''))
  }
  return res.status(201).json(oficial ? { ...creado, ...oficial } : creado)
})

// ── Seguimiento del pedido ────────────────────────────────────────────────
//
// ⚠️ EXIGE SESIÓN, y no por costumbre: aquí se devuelve el pedido de UNA
// persona. Sin ella bastaría con probar identificadores para leer pedidos
// ajenos. Por eso el filtro es negocio + TELÉFONO DE LA SESIÓN + id, nunca el
// número correlativo: ese es #1, #2, #3… y se adivina de corrido.
//
// Un pedido que no sea suyo devuelve el MISMO 404 que uno que no existe: si
// distinguiera los dos casos, se podría averiguar qué pedidos tiene el vecino.
/**
 * Mis pedidos en este negocio. Alimenta la pestaña de Cuenta.
 *
 * ⚠️ Va declarada ANTES que `/orders/:id`: Express resuelve por orden, y una
 * ruta con parámetro no se traga esta porque son caminos distintos, pero
 * dejarlas juntas y en este orden evita sorpresas si mañana cambia una.
 */
router.get('/api/store/:slug/orders', requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const { data, error } = await db.getStorefrontOrders({ businessId, contactPhone })
  if (error) return res.status(500).json({ error: 'No pudimos consultar tus pedidos' })
  // Agrupadas aquí, como en el pedido suelto: la lista enseña lo que se pidió.
  return res.json((data || []).map(pedido => conOpcionesAgrupadas(pedido as Record<string, unknown>)))
})

router.get('/api/store/:slug/orders/:id', requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const orderId = String(req.params.id || '').trim()
  if (!orderId) return res.status(404).json({ error: 'No encontramos ese pedido' })

  const { data, error } = await db.getStorefrontOrder({ businessId, contactPhone, orderId })
  if (error) return res.status(500).json({ error: 'No pudimos consultar tu pedido' })
  if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
  // Agrupadas aquí y no en la app: el mismo plato tiene que leerse igual en el
  // seguimiento, en el panel del dueño y en el WhatsApp del cliente.
  return res.json(conOpcionesAgrupadas(data as Record<string, unknown>))
})

/** Datos bancarios para transferir. Solo con sesión y solo del propio negocio. */
router.get('/api/store/:slug/payment-info', requireStorefrontSession, async (req, res) => {
  const account = await db.getBusinessBankAccount(req.storefront!.businessId)
  if (!account) return res.status(404).json({ error: 'El negocio no tiene datos de pago cargados' })
  return res.json(account)
})

// ── Pagar con tarjeta ─────────────────────────────────────────────────────
//
// La app pide pagar un pedido YA creado y recibe la URL de la página de
// PayPhone. ⚠️ El monto no viaja en la petición: sale de `orders.total` en la
// base (`start_card_payment`), y la pertenencia se comprueba allí con las tres
// cosas a la vez — negocio, pedido y teléfono de la sesión.
const RESPUESTA_AL_INICIAR: Record<string, { status: number; error: string }> = {
  no_disponible: { status: 409, error: 'El pago con tarjeta no está disponible ahora mismo' },
  no_encontrado: { status: 404, error: 'No encontramos ese pedido' },
  no_es_tarjeta: { status: 409, error: 'Este pedido no se paga con tarjeta' },
  ya_pagado: { status: 409, error: 'Este pedido ya está pagado' },
  no_cobrable: { status: 409, error: 'Este pedido ya no se puede pagar' },
  demasiados_intentos: { status: 429, error: 'Demasiados intentos de pago. Espera un rato o elige otro método' },
  fallo_proveedor: { status: 502, error: 'No pudimos abrir el pago con tarjeta. Inténtalo de nuevo' },
}

router.post('/api/store/:slug/orders/:id/tarjeta', orderLimiter, requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const orderId = String(req.params.id || '').trim()
  const business = await db.getBusinessById(businessId)
  const inicio = await pagosConTarjeta().iniciar({
    businessId,
    orderId,
    telefono: contactPhone,
    nombreDelLocal: String(business?.name || 'Umbani'),
  })
  if (inicio.resultado === 'ok') return res.json({ url: inicio.url })
  const respuesta = RESPUESTA_AL_INICIAR[inicio.resultado] || RESPUESTA_AL_INICIAR.no_disponible
  return res.status(respuesta.status).json({ error: respuesta.error, reason: inicio.resultado })
})

/**
 * ¿En qué quedó el cobro? Lo pregunta la pantalla de «confirmando tu pago».
 *
 * ⚠️ Primero se comprueba que el pedido es de la persona de la sesión (el
 * mismo 404 que un pedido que no existe) y solo entonces se lee su cobro.
 */
router.get('/api/store/:slug/orders/:id/tarjeta', requireStorefrontSession, async (req, res) => {
  const { businessId, contactPhone } = req.storefront!
  const orderId = String(req.params.id || '').trim()
  const { data, error } = await db.getStorefrontOrder({ businessId, contactPhone, orderId })
  if (error) return res.status(500).json({ error: 'No pudimos consultar tu pago' })
  if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const pedido = data as { status?: string | null; payment_confirmed_at?: string | null }
  const cobro = await db.getLatestCardPayment(businessId, orderId).catch(() => null)
  return res.json({
    pagado: Boolean(pedido.payment_confirmed_at),
    estadoDelPedido: pedido.status || null,
    estado: cobro?.status || null,
    marca: cobro?.card_brand || null,
    ultimos: cobro?.card_last_digits || null,
  })
})

// ── Comprobante de la transferencia ────────────────────────────────────────
//
// Es OPCIONAL a propósito: el pedido ya está creado cuando se llega aquí, así
// que un cliente que no encuentra la foto no pierde su pedido.
//
// La imagen la sube el SERVIDOR a Cloudinary. La app nunca ve credenciales, y
// la URL que se guarda es la que devuelve Cloudinary, no una que mande el
// teléfono: si no, cualquiera colgaría un enlace arbitrario en el pedido.
const proofUpload: RequestHandler = (req, res, next) => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.image } })
    .single('file')(req, res, error => {
      if (error) {
        const mapped = mapMulterError(error)
        return res.status(mapped.status).json({ error: mapped.error })
      }
      next()
    })
}

router.post(
  '/api/store/:slug/orders/:id/proof',
  orderLimiter,
  requireStorefrontSession,
  proofUpload,
  async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    if (!req.file) return res.status(400).json({ error: 'No se recibió el comprobante' })

    const invalido = validateMediaFile(req.file)
    if (invalido) return res.status(invalido.status).json({ error: invalido.error })
    if (!req.file.mimetype?.startsWith('image/')) {
      return res.status(400).json({ error: 'El comprobante debe ser una imagen' })
    }
    if (!(await isConfigured())) {
      return res.status(503).json({ error: 'El negocio no puede recibir comprobantes ahora mismo' })
    }

    try {
      // PRIVADO: un comprobante bancario no puede vivir en una URL pública y
      // permanente. Se sube como `authenticated` y solo se ve con una firma
      // temporal que genera el servidor.
      const subida = await uploadPrivateMedia(req.file.buffer, businessId)
      const orderId = String(req.params.id || '')
      const { data, error } = await db.attachStorefrontPaymentProof({
        businessId,
        orderId,
        contactPhone,
        url: subida.url,
        publicId: subida.public_id,
      })
      if (error) {
        console.error('❌ comprobante:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No pudimos guardar tu comprobante' })
      }
      const resultado = (data || {}) as { result?: string }
      // La huella y el análisis, sin `await`: el comprobante ya está adjunto y
      // un fallo aquí no puede deshacerlo ni dejar al cliente sin respuesta.
      //
      // ⚠️ EL ANÁLISIS VA AQUÍ, y hasta el 2026-09-13 no iba (lo destapó una
      // prueba de aceptación). `registrarComprobante` no llama a la visión: la
      // ESPERA ya hecha, porque quien la llamó antes no debe pagarla dos veces.
      // Sin pasársela, el comprobante se quedaba en `pendiente_analisis` para
      // siempre: la huella sí se calculaba —el duplicado se cazaba— pero NADIE
      // comprobaba ni el monto ni la cuenta de destino, que son las dos únicas
      // señales críticas. Por esta puerta el dinero entraba sin revisar.
      //
      // ⚠️ Aquí NO corta, y esa es la diferencia deliberada con el chat. Allí
      // la visión corre ANTES de subir, así que un comprobante que no cuadra
      // se rechaza sin gastar almacenamiento ni encender la alarma. Aquí el
      // archivo ya está adjunto cuando se sabe, y el pedido ya está en
      // `pago_en_revision` — que es exactamente el estado donde una PERSONA
      // mira antes de aceptar. Lo que faltaba era que esa persona viera las
      // señales; ahora las ve puntuadas en su panel.
      //
      // ⚠️ Falla ABIERTO en cada paso: sin análisis, sin pedido o ante
      // cualquier excepción se registra como antes. Nunca deja al cliente sin
      // su «ok» ni deshace un comprobante ya adjunto.
      if (resultado.result !== 'not_found') {
        const imagen = req.file.buffer
        const mimeType = req.file.mimetype
        const fileUrl = subida.url
        const filePublicId = subida.public_id
        const perceptualHash = subida.phash ?? null
        void (async () => {
          const vision = require('../services/receipt-vision') as typeof import('../services/receipt-vision')
          const ingest = require('../services/receipt-ingest') as typeof import('../services/receipt-ingest')
          const analisis = await vision.analizarComprobante(imagen, mimeType)
            .catch(() => undefined)
          const pedido = await db.getOrderForReceiptCheck(businessId, orderId)
            .catch(() => null)
          await ingest.registrarComprobante({
            businessId,
            orderId,
            imagen,
            fileUrl,
            filePublicId,
            perceptualHash,
            mimeType,
            analisis,
            esperado: pedido
              ? {
                total: Number(pedido.total ?? 0),
                createdAt: pedido.created_at ?? null,
                clienteNombre: pedido.contact_name ?? null,
              }
              : undefined,
          })
        })().catch(() => { /* el comprobante ya está adjunto; esto es la capa de encima */ })
      }
      if (resultado.result === 'not_found') {
        return res.status(404).json({ error: 'Ese pedido no es tuyo o ya no existe' })
      }
      if (resultado.result === 'invalid_state') {
        return res.status(409).json({ error: 'Ese pedido ya está cerrado' })
      }
      return res.json({ ok: true })
    } catch (error) {
      console.error('❌ comprobante:', (error as Error).message)
      return res.status(500).json({ error: 'No pudimos subir tu comprobante' })
    }
  },
)

// ── Cotizar sin crear el pedido ────────────────────────────────────────────
//
// Devuelve el total EXACTO que se va a cobrar, con su desglose, sin escribir
// nada. Lo pide el checkout antes de confirmar: la app calcula mientras el
// cliente elige —para que la pantalla responda al instante— pero el número que
// se enseña justo antes de pagar tiene que venir del servidor.
//
// Usa el mismo `pricing.ts` cuya lógica replica la RPC, así que si la
// cotización y el cobro difirieran, lo cazan las pruebas que ambos comparten.
//
// No crea ni reserva nada, así que va con el catálogo: público y con freno.
const cotizarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas, espera un momento' },
})

router.post('/api/store/:slug/quote', cotizarLimiter, readStorefrontSession, async (req, res) => {
  const businessId = req.storeBusinessId!
  const body = (req.body || {}) as Record<string, unknown>
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : []
  if (!items.length) return res.status(400).json({ error: 'No hay nada que cotizar' })

  const [productos, variantes, grupos, opciones, business] = await Promise.all([
    db.getStorefrontProducts(businessId),
    db.getStorefrontVariants(businessId),
    db.getStorefrontOptionGroups(businessId),
    db.getStorefrontOptions(businessId),
    db.getBusinessBySlug(String(req.params.slug || '').trim()),
  ])

  const reglaPrecio = reglaDeMargen(
    await db.getBusinessPricingRule(businessId).catch(() => null),
  )

  const cotizacion = quoteCart({
    items: items as never,
    products: productos as never,
    variants: variantes as never,
    optionGroups: grupos as never,
    options: opciones as never,
    deliveryFee: Number((business as { delivery_fee?: unknown } | null)?.delivery_fee) || 0,
    fulfillment: String(body.fulfillment || 'pickup'),
    pricing: reglaPrecio,
  })

  if (cotizacion.error) return res.status(400).json({ error: cotizacion.error })
  return res.json(cotizacion)
})

export = router
