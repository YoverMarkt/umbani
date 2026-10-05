import type { RequestHandler, Response } from 'express'
import { createRouter } from '../middleware/async'
import type { BusinessMenu, BusinessTemplate, WriteResult } from '../db/types'

/** Lo que devuelve `apply_business_template`: qué dejó cargado, o por qué no. */
interface TemplateSummary {
  aplicada: boolean
  motivo?: string
  categorias: number
  /** Listas reutilizables: los sabores de una pizzería. */
  listas: number
  /** Productos de ejemplo. Nacen agotados siempre. */
  productos: number
  grupos: number
  opciones: number
}

/** Lo que devuelve `apply_business_menu`: la plantilla más los tamaños. */
interface MenuSummary extends TemplateSummary {
  variantes?: number
}
import {
  getPlanDefinition,
  normalizePlanId,
  type PlanDefinition,
  type PlanId,
} from '../config/plans'
import {
  diagnoseChannels,
  tieneCanalPropio,
  type ChannelActivity,
  type DiagnosableBusiness,
} from '../services/channel-health'
import { getPlatformChannel } from '../services/platform-channel'
const ALLOWED_ERROR_CATEGORIES = ['canal', 'ia', 'envio', 'servidor', 'pagos']

interface PlatformErrorRow {
  id: string
  business_id: string | null
  category: string
  code: string | null
  message: string
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}
import { recordError } from '../services/error-log'
import { validarCarta } from '../services/carta-del-local'
import { prepTimeForBusinessType, templateForBusinessType } from '../services/business-templates'
import { slugLibre } from '../lib/slug'
import { esCorreoRepetido } from '../lib/duplicados'
import { sanitizeBusinessForAdmin, type BusinessRecord } from '../services/secrets'
import { normalizeChannelIdentifier } from '../types/channels'

interface DatabaseError {
  message?: string
}

interface DatabaseResult<T = unknown> {
  data?: T
  error?: DatabaseError | null
}

interface CreatedBusiness extends BusinessRecord {
  id: string
}

const db: {
  getAdminStats(): Promise<unknown>
  getAllBusinesses(): Promise<unknown[]>
  getLastInboundByBusiness(businessIds: string[]): Promise<ChannelActivity[]>
  getPlatformLastInboundAt(): Promise<string | null>
  getPlatformBlocked(): Promise<{
    phone: string
    blockedAt: string
    reason: string | null
    until: string | null
    kind: 'manual' | 'insultos'
  }[]>
  setPlatformBlocked(
    phone: string,
    blocked: boolean,
    reason?: string | null,
  ): Promise<{ phone: string; blocked: boolean }>
  getPlatformErrors(options: {
    category?: string
    businessId?: string
    limit?: number
  }): Promise<PlatformErrorRow[]>
  getBusinessById(businessId: string): Promise<CreatedBusiness | null>
  /** Los cajones del menú del chat, para el selector del superadmin. */
  getAllMarketplaceCategories(): Promise<
    { code: string; label: string; emoji: string | null }[]
  >
  getBusinessMarketplaceCategories(
    businessId: string,
  ): Promise<{ code: string; principal: boolean }[]>
  setBusinessMarketplaceCategories(businessId: string, codes: string[]): Promise<number>
  /** Cómo usa la gente el menú de Umbani: embudo, cajones y búsquedas. */
  getMarketplaceUsage(dias?: number): Promise<{
    embudo: { paso: string; orden: number; clientes: number }[]
    cajones: {
      code: string; label: string; entradas: number; eligieron: number; abandonaron: number
    }[]
    busquedas: { consulta: string; veces: number; sin_nada: number; entendido: string | null }[]
  }>
  getBusinessBySlug(slug: string): Promise<{ id?: string } | null>
  getClientUserByBusiness(businessId: string): Promise<{ email?: string } | null>
  createBusinessOnboarding(
    business: Record<string, unknown>,
    clientEmail: string | null,
    passwordHash: string | null,
    monthlyRate: number | null,
  ): Promise<WriteResult<CreatedBusiness>>
  applyBusinessTemplate(
    businessId: string,
    template: BusinessTemplate,
  ): Promise<WriteResult<TemplateSummary>>
  applyBusinessMenu(
    businessId: string,
    menu: BusinessMenu,
  ): Promise<WriteResult<MenuSummary>>
  updateBusiness(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
  deleteBusiness(businessId: string): Promise<DatabaseResult>
  suspendBusiness(businessId: string, reason: string): Promise<DatabaseResult>
  setBotActive(businessId: string, active: boolean): Promise<DatabaseResult>
  reactivateBusiness(businessId: string): Promise<DatabaseResult>
  updateBusinessPlanBilling(
    businessId: string,
    plan: string,
    monthlyRate: number,
    monthlyContactLimit: number,
    monthlyOutboundMessageLimit: number,
  ): Promise<DatabaseResult>
  createClientUser(data: Record<string, unknown>): Promise<DatabaseResult>
  updateClientUser(
    businessId: string,
    email: string,
    passwordHash: string | null,
  ): Promise<DatabaseResult>
  getProducts(businessId: string): Promise<unknown[]>
  getConversations(businessId: string): Promise<unknown[]>
} = require('../db') as typeof import('../db')
const auth: {
  authAdmin: RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')
const bcrypt = require('bcryptjs') as {
  hash(value: string, rounds: number): Promise<string>
}

const router = createRouter()
const MIN_PASSWORD_LENGTH = 12
// 'marketplace' = el negocio no tiene canal propio y lo atiende el número de
// la plataforma. Es el único proveedor que no exige credenciales, porque no
// hay ninguna cuenta suya que configurar (2026-08-20).
const ALLOWED_MESSAGING_PROVIDERS = ['ycloud', 'meta', 'telegram', 'marketplace'] as const
type MessagingProvider = (typeof ALLOWED_MESSAGING_PROVIDERS)[number]
type UsageLimits = {
  monthly_contact_limit: number
  monthly_outbound_message_limit: number
}

function configuredText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function configuredWhatsAppProvider(
  body: Record<string, unknown>,
): MessagingProvider | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'whatsapp_provider')) return 'ycloud'
  if (!configuredText(body.whatsapp_provider)) return null
  const provider = String(body.whatsapp_provider).trim()
  return ALLOWED_MESSAGING_PROVIDERS.find(candidate => candidate === provider) || null
}

function channelIdentifierFormatError(body: Record<string, unknown>): string | null {
  for (const [field, label] of [
    ['whatsapp_number', 'El número de WhatsApp'],
    ['ycloud_number', 'El número YCloud'],
  ] as const) {
    if (configuredText(body[field])
      && !normalizeChannelIdentifier('phone', String(body[field]))) {
      return `${label} debe usar formato internacional E.164 con 8 a 15 dígitos`
    }
  }
  for (const [field, label] of [
    ['meta_phone_id', 'El Phone ID de Meta'],
    ['ycloud_webhook_endpoint_id', 'El Endpoint ID de YCloud'],
  ] as const) {
    if (configuredText(body[field])
      && !normalizeChannelIdentifier('account_id', String(body[field]))) {
      return `${label} es inválido`
    }
  }
  return null
}

function channelConfigurationError(body: Record<string, unknown>): string | null {
  const formatError = channelIdentifierFormatError(body)
  if (formatError) return formatError
  const provider = configuredWhatsAppProvider(body)
  if (!provider) return 'Proveedor de mensajería no válido'
  if (provider === 'ycloud' && !configuredText(body.ycloud_api_key)
    && !configuredText(process.env.YCLOUD_API_KEY)) {
    return 'Configura una API Key de YCloud antes de guardar el negocio'
  }
  if (provider === 'ycloud' && !configuredText(body.ycloud_webhook_secret)
    && !configuredText(process.env.YCLOUD_WEBHOOK_SECRET)) {
    return 'YCloud requiere el Signing Secret del webhook antes de guardar el negocio'
  }
  if (provider === 'ycloud' && !configuredText(body.ycloud_webhook_endpoint_id)
    && !configuredText(process.env.YCLOUD_WEBHOOK_ENDPOINT_ID)) {
    return 'YCloud requiere el Endpoint ID del webhook antes de guardar el negocio'
  }
  if (provider === 'meta'
    && (!configuredText(body.meta_token) || !configuredText(body.meta_phone_id))) {
    return 'Meta requiere Token y Phone ID antes de guardar el negocio'
  }
  if (provider === 'telegram' && !configuredText(body.telegram_bot_token)
    && !configuredText(process.env.TELEGRAM_BOT_TOKEN)) {
    return 'Telegram requiere un Bot Token antes de guardar el negocio'
  }
  // El marketplace no pide credenciales —no hay cuenta suya que configurar—
  // pero tampoco admite un número propio: la base lo rechaza con
  // `businesses_marketplace_sin_canal_check`, y aquí se dice por qué en vez de
  // dejar que el superadmin lea una violación de restricción.
  if (provider === 'marketplace') {
    for (const [field, label] of [
      ['whatsapp_number', 'un número de WhatsApp'],
      ['ycloud_number', 'un número YCloud'],
      ['meta_phone_id', 'un Phone ID de Meta'],
    ] as const) {
      if (configuredText(body[field])) {
        return `Un negocio del marketplace se atiende por el número de la plataforma, así que no puede tener ${label}`
      }
    }
    // El teléfono del dueño es el ÚNICO número que tiene un local del
    // marketplace, y es lo que le deja pedir sus reportes por WhatsApp. Se
    // valida el formato solo aquí: ningún negocio anterior es de marketplace,
    // así que esto no puede romper la edición de los que ya existen.
    if (configuredText(body.owner_phone)
      && !normalizeChannelIdentifier('phone', String(body.owner_phone))) {
      return 'El WhatsApp del dueño debe usar formato internacional E.164 con 8 a 15 dígitos'
    }
  }
  return null
}

const ALLOWED_BUSINESS_FIELDS = [
  'name', 'type', 'description', 'hours', 'address', 'phone', 'social',
  // El punto del local, el mismo que edita el dueño en su panel.
  'latitude', 'longitude',
  'payment_methods', 'whatsapp_number', 'whatsapp_provider', 'plan',
  'active', 'bot_active', 'suspended', 'notes', 'slogan',
  'owner_phone', 'ycloud_api_key', 'ycloud_number',
  'ycloud_webhook_endpoint_id', 'ycloud_webhook_secret',
  'meta_token', 'meta_phone_id', 'telegram_bot_token',
  'takes_orders',
  // ⚠️ `chat_mode` salió de aquí el 2026-09-16: con un solo modo, dejar que el
  // panel o la API lo escriban solo sirve para volver a ponerlo mal. Lo fija
  // el alta y lo hace cumplir el CHECK de la base.
  'storefront_enabled',
  // Cobro con tarjeta (PayPhone). SOLO aquí: el dinero entra en la cuenta de
  // Umbani, así que no lo enciende el dueño desde su panel.
  'card_mode',
  // Quién lleva los pedidos: el local (como hoy) o los motorizados de Umbani.
  'delivery_by',
  // Repartidores propios, local por local (2026-10-04). SOLO aquí: decide qué
  // repartidores pueden llevar sus pedidos, así que no se lo enciende el local.
  'own_fleet',
] as const

function assertDatabaseResult(result: DatabaseResult, operation: string): void {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido'
}

function safeFailure(res: Response, context: string, error: unknown) {
  console.error(`❌ ${context}:`, errorMessage(error))
  // El panel solo puede decir «no se pudo»: enseñar el error de la base a un
  // navegador filtraría nombres de tablas y restricciones. Pero el motivo real
  // TIENE que quedar en algún sitio consultable — si no, un fallo como el del
  // alta de clientes (2026-08-02) se vuelve invisible: el panel decía «no se
  // pudo crear el cliente» y el registro de errores estaba vacío.
  void recordError({
    category: 'servidor',
    code: context,
    message: errorMessage(error),
  })
  return res.status(500).json({ error: `No se pudo ${context}` })
}

/**
 * Deja el catálogo de arranque del tipo de negocio: sus categorías, los grupos
 * típicos, sus listas y un producto de ejemplo AGOTADO armado como se arma de
 * verdad en ese tipo (2026-09-16).
 *
 * Va DESPUÉS del alta y no puede tumbarla. Cuando se llega aquí el negocio, su
 * dueño, sus políticas y su cuota mensual ya existen y son transaccionales; una
 * plantilla que falle no puede deshacer nada de eso ni devolver un 500 por un
 * cliente que en realidad SÍ se creó. Por eso se traga el error y lo manda al
 * registro, que es donde se mira cuando algo no cuadra.
 *
 * Que no haya plantilla es lo normal —una ferretería no trae carta— y no se
 * registra como error.
 */
const seedBusinessCatalog = async (
  businessId: string,
  type: string,
  name: string,
): Promise<void> => {
  const template = templateForBusinessType(type)
  if (!template) return

  try {
    const seeded = await db.applyBusinessTemplate(businessId, template)
    assertDatabaseResult(seeded, 'aplicar la plantilla del tipo')
    const summary = seeded.data
    if (summary?.aplicada) {
      console.log(
        `🛒 Catálogo inicial de ${name} (${type}) — ${summary.categorias} categorías, `
        + `${summary.productos} producto(s) de ejemplo agotados, ${summary.listas} lista(s), `
        + `${summary.grupos} grupos de opciones`,
      )
    }
  } catch (error) {
    console.error('❌ aplicar la plantilla del tipo:', errorMessage(error))
    void recordError({
      businessId,
      category: 'servidor',
      code: 'plantilla-tipo-negocio',
      message: errorMessage(error),
      context: { type },
    })
  }
}

/**
 * Carga la carta REVISADA del local en lugar de los productos de ejemplo.
 *
 * Igual que la plantilla, va DESPUÉS del alta y no puede tumbarla: el negocio
 * ya existe y es transaccional. Pero aquí un fallo NO se traga en silencio:
 * alguien revisó esa carta producto a producto, y tiene que saber que no
 * entró. Se devuelve como aviso en la respuesta del alta.
 */
const cargarCartaDelLocal = async (
  businessId: string,
  menu: BusinessMenu,
  name: string,
): Promise<{ resumen: MenuSummary } | { aviso: string }> => {
  try {
    const cargada = await db.applyBusinessMenu(businessId, menu)
    assertDatabaseResult(cargada, 'cargar la carta del local')
    const resumen = cargada.data
    if (!resumen?.aplicada) {
      return { aviso: `La carta no se cargó: ${resumen?.motivo || 'motivo desconocido'}` }
    }
    console.log(
      `🛒 Carta de ${name} cargada — ${resumen.categorias} categorías, `
      + `${resumen.productos} productos, ${resumen.variantes ?? 0} tamaños`,
    )
    return { resumen }
  } catch (error) {
    console.error('❌ cargar la carta del local:', errorMessage(error))
    void recordError({
      businessId,
      category: 'servidor',
      code: 'carta-del-local',
      message: errorMessage(error),
    })
    return { aviso: 'El local se creó, pero la carta no se pudo guardar: sus productos habrá que cargarlos a mano.' }
  }
}

/**
 * Guarda en qué cajones del menú del chat aparece el local.
 *
 * ⚠️ Solo si el cuerpo TRAE la lista. Sin ella no se toca nada, y el local
 * sigue saliendo por su tipo — que es como vivieron todos hasta el
 * 2026-09-17 y como siguen viviendo los que nadie ha editado.
 *
 * El PRIMERO de la lista es el principal. Una lista vacía es una decisión
 * válida: devuelve el local a lo que diga su tipo.
 *
 * Devuelve el motivo si la lista no vale, para contestar 400 con algo que se
 * entienda en vez del error crudo de PostgreSQL.
 */
const guardarCajonesDelMenu = async (
  businessId: string,
  body: Record<string, unknown>,
): Promise<string | null> => {
  if (!('marketplace_categories' in body)) return null
  const lista = body.marketplace_categories
  if (!Array.isArray(lista) || lista.some(item => typeof item !== 'string')) {
    return 'Los cajones del menú se mandan como una lista de códigos'
  }
  try {
    await db.setBusinessMarketplaceCategories(businessId, lista as string[])
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

// ⚠️ Aquí vivían `invalidChatMode` y `miniappConfigurationError`, y las dos se
// fueron el 2026-09-16 con el modo menú.
//
// La segunda tiene historia y conviene no repetirla: exigía pedidos Y tienda
// para el modo mini app, lo cual tenía sentido mientras hubiera OTRO modo al
// que caer. Con un solo modo pasaba a significar «todo local tiene que
// vender», que es falso — un local oculto mientras carga su catálogo no vende
// y tiene que poder guardarse. Era, además, la razón por la que el panel
// escribía `chat_mode: 'menu'` al ocultar un local: esquivaba esta excepción.
//
// Lo que protegía sigue en pie por los dos extremos: `runMiniappMode` responde
// un recordatorio en vez de un enlace a una app vacía, y
// `marketplace_categories_disponibles` esconde del menú al local que no vende.

function usageLimitsForPlan(plan: PlanDefinition): UsageLimits {
  return {
    monthly_contact_limit: plan.monthlyContactLimit,
    monthly_outbound_message_limit: plan.monthlyOutboundMessageLimit,
  }
}

function requestedPlan(body: Record<string, unknown>, fallback: PlanId): PlanDefinition | null {
  return getPlanDefinition('plan' in body ? body.plan : fallback)
}

// Dos negocios NUNCA pueden compartir el mismo identificador de canal: el bot
// resuelve a qué negocio pertenece cada mensaje por el número de WhatsApp o el
// slug de Telegram. La base lo bloquea; aquí se traduce a un mensaje entendible
// en vez del genérico "no se pudo actualizar".
function duplicateChannelMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  if (!/duplicate key|llave duplicada/i.test(error.message)) return null
  if (/whatsapp_number|business_channel_phone|business_channel_identifier/i.test(error.message)) {
    return 'Ese número de WhatsApp ya está asignado a otro negocio. Cada negocio necesita su propio número: quítalo del otro negocio antes de asignarlo aquí.'
  }
  if (/businesses_slug_key|\bslug\b/i.test(error.message)) {
    return 'Ese identificador (slug) ya lo usa otro negocio. Elige uno distinto.'
  }
  // ⚠️ Decir CUÁL: con «ese dato» a secas el dueño repitió el alta cinco
  // veces sin saber que era el correo (ver lib/duplicados).
  if (esCorreoRepetido(error)) {
    return 'Ese correo ya es el acceso al panel de otro negocio. Usa otro correo para este dueño.'
  }
  return 'Ese dato ya está registrado en otro negocio y debe ser único.'
}

router.get('/api/admin/stats', auth.authAdmin, async (_req, res) => {
  res.json(await db.getAdminStats())
})

// Vigilancia del canal de entrada: responde "¿siguen llegando mensajes?".
// Existe porque en julio de 2026 el bot estuvo cinco días mudo sin que nada
// avisara — el servidor vivía, pero ningún WhatsApp entraba.
//
// ⚠️ Desde el 2026-08-23 el sujeto es el NÚMERO DE LA PLATAFORMA. Antes se
// preguntaba por cada local, y con un número compartido esa consulta no
// encuentra nada nunca: los mensajes del marketplace se encolan con
// `business_id` NULL. El semáforo por negocio se conserva para quien tenga
// canal propio, y solo se le pregunta a esos — preguntar por un local de
// marketplace es gastar una consulta para recibir siempre «null».
//
// ⚠️ Se retiró `errorsByBusiness`: lo declaraba el tipo del panel y no lo
// pintaba nadie, y además descartaba los errores con `business_id` NULL, que
// hoy son cinco de cada seis. Los errores se leen en su propia pantalla.
router.get('/api/admin/channel-health', auth.authAdmin, async (_req, res) => {
  const businesses = await db.getAllBusinesses() as DiagnosableBusiness[]
  const conCanalPropio = businesses.filter(tieneCanalPropio)
  const [activity, platformLastInboundAt, platformChannel] = await Promise.all([
    db.getLastInboundByBusiness(conCanalPropio.map(business => business.id)),
    db.getPlatformLastInboundAt(),
    // Un fallo leyendo `server_settings` no puede tumbar la vigilancia entera:
    // se trata como «no configurado», que es lo que el panel sabe pintar.
    getPlatformChannel().catch(() => null),
  ])
  res.json(diagnoseChannels({
    businesses,
    activity,
    platform: {
      configured: Boolean(platformChannel),
      lastInboundAt: platformLastInboundAt,
    },
  }))
})

// ── Bloqueo de PLATAFORMA ──────────────────────────────────────────────────
//
// Distinto del bloqueo del dueño, y por eso vive aquí y no en el panel del
// negocio: aquel lo pone un local y solo cierra ese local —que El Puerto te
// expulse no puede dejarte fuera de Umbani entero—; este lo pone el superadmin
// y significa que la plataforma deja de atender a esa persona: el bot no
// responde y NINGÚN local acepta su pedido, ni siquiera de mostrador.
router.get('/api/admin/blocked', auth.authAdmin, async (_req, res) => {
  res.json(await db.getPlatformBlocked())
})

router.put('/api/admin/blocked/:phone', auth.authAdmin, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone)
  const body = req.body as { blocked?: unknown; reason?: unknown }
  const blocked = body?.blocked === true
  const reason = typeof body?.reason === 'string' ? body.reason : null
  try {
    res.json(await db.setPlatformBlocked(phone, blocked, reason))
  } catch (error) {
    // El único fallo esperable es un teléfono mal escrito, y ese sí se le dice
    // al superadmin: cualquier otro se registra sin exponer el detalle.
    const mensaje = error instanceof Error ? error.message : ''
    if (/dígitos/i.test(mensaje)) return res.status(400).json({ error: mensaje })
    console.error('❌ bloqueo de plataforma:', mensaje)
    void recordError({
      businessId: null,
      category: 'servidor',
      code: 'bloqueo de plataforma',
      message: mensaje || 'fallo desconocido',
      context: {},
    })
    res.status(500).json({ error: 'No se pudo actualizar el bloqueo' })
  }
})

// Registro de errores para diagnosticar sin entrar a los logs del servidor.
router.get('/api/admin/errors', auth.authAdmin, async (req, res) => {
  const query = req.query as Record<string, string | undefined>
  res.json(await db.getPlatformErrors({
    category: ALLOWED_ERROR_CATEGORIES.includes(String(query.category))
      ? query.category
      : undefined,
    businessId: query.business_id,
    limit: Number(query.limit) || 200,
  }))
})

// Descarga en CSV para compartir el diagnóstico. Los mensajes ya salen
// saneados de `services/error-log.ts`: sin credenciales ni datos personales.
router.get('/api/admin/errors/export', auth.authAdmin, async (_req, res) => {
  const errors = await db.getPlatformErrors({ limit: 1000 })
  const rows = [
    ['ultima_vez', 'primera_vez', 'veces', 'categoria', 'codigo', 'negocio', 'mensaje'],
    ...errors.map(error => [
      error.last_seen_at,
      error.first_seen_at,
      String(error.occurrences),
      error.category,
      error.code || '',
      error.business_id || 'plataforma',
      error.message,
    ]),
  ]
  const csv = rows
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="errores-${stamp}.csv"`)
  res.send(`﻿${csv}`)
})

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
    const avisos = [
      cargaDeCarta && 'aviso' in cargaDeCarta ? cargaDeCarta.aviso : null,
      cajonesMal,
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
  if ('delivery_by' in body && body.delivery_by !== 'local' && body.delivery_by !== 'umbani') {
    return res.status(400).json({ error: 'Quién reparte: el local o Umbani' })
  }
  // Un «true» en texto o un 1 no se adivinan: decide quién lleva la comida.
  if ('own_fleet' in body && typeof body.own_fleet !== 'boolean') {
    return res.status(400).json({ error: 'Repartidores propios: encendido o apagado' })
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

export = router
