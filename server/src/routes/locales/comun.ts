// ═══════════════════════════════════════════════════════════════════════════
// LAS RUTAS DE LOCALES DEL SUPERADMIN: LO QUE COMPARTEN
// ═══════════════════════════════════════════════════════════════════════════
//
// El router es UNO (`routes/admin-clients.routes.ts`); sus secciones viven en
// esta carpeta desde el 2026-10-07, cuando el archivo pasó de 1.000 líneas
// (regla del dueño). Aquí: la base, los tipos y la validación de la ficha.

import type { RequestHandler, Response } from 'express'
import type { BusinessMenu, BusinessTemplate, WriteResult } from '../../db/types'
import { getPlanDefinition, type PlanDefinition, type PlanId } from '../../config/plans'
import type { ChannelActivity } from '../../services/channel-health'
import { recordError } from '../../services/error-log'
import { templateForBusinessType } from '../../services/business-templates'
import { esCorreoRepetido } from '../../lib/duplicados'
import type { BusinessRecord } from '../../services/secrets'
import { normalizeChannelIdentifier } from '../../types/channels'

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
export const ALLOWED_ERROR_CATEGORIES = ['canal', 'ia', 'envio', 'servidor', 'pagos']

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

export const db: {
  getAdminStats(): Promise<unknown>
  /** La ciudad existe (2026-10-05): la ficha del local solo acepta una de verdad. */
  getCity(id: string): Promise<{ id: string } | null>
  getCooperative(id: string): Promise<{ id: string; city_id: string; active: boolean } | null>
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
} = require('../../db') as typeof import('../../db')
export const auth: {
  authAdmin: RequestHandler
} = require('../../middleware/auth') as typeof import('../../middleware/auth')
export const bcrypt = require('bcryptjs') as {
  hash(value: string, rounds: number): Promise<string>
}

export const MIN_PASSWORD_LENGTH = 12
// 'marketplace' = el negocio no tiene canal propio y lo atiende el número de
// la plataforma. Es el único proveedor que no exige credenciales, porque no
// hay ninguna cuenta suya que configurar (2026-08-20).
const ALLOWED_MESSAGING_PROVIDERS = ['ycloud', 'meta', 'telegram', 'marketplace'] as const
type MessagingProvider = (typeof ALLOWED_MESSAGING_PROVIDERS)[number]
type UsageLimits = {
  monthly_contact_limit: number
  monthly_outbound_message_limit: number
}

export function configuredText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function configuredWhatsAppProvider(
  body: Record<string, unknown>,
): MessagingProvider | null {
  if (!Object.prototype.hasOwnProperty.call(body, 'whatsapp_provider')) return 'ycloud'
  if (!configuredText(body.whatsapp_provider)) return null
  const provider = String(body.whatsapp_provider).trim()
  return ALLOWED_MESSAGING_PROVIDERS.find(candidate => candidate === provider) || null
}

export function channelIdentifierFormatError(body: Record<string, unknown>): string | null {
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

export function channelConfigurationError(body: Record<string, unknown>): string | null {
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

export const UUID_CIUDAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ALLOWED_BUSINESS_FIELDS = [
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
  // Quién lleva los pedidos: el local (como hoy), los motorizados de Umbani o
  // los de UNA cooperativa (2026-10-06), que va en `cooperative_id`.
  'delivery_by',
  'cooperative_id',
  // Repartidores propios, local por local (2026-10-04). SOLO aquí: decide qué
  // repartidores pueden llevar sus pedidos, así que no se lo enciende el local.
  'own_fleet',
  // Su ciudad (2026-10-05). SOLO aquí: sin ella el local no aparece a ningún
  // cliente, y cambiarla lo mueve de menú.
  'city_id',
] as const

export const QUIEN_REPARTE = ['local', 'umbani', 'cooperativa']

/**
 * «Quién reparte: la cooperativa» dice CUÁL, y es de la ciudad del local
 * (2026-10-06). La base lo exige igual —CHECK y disparador—; aquí se dice con
 * palabras, antes de que la base lo rechace con un «no se pudo». Con «el
 * local» o «Umbani», la cooperativa se suelta. Deja `body.cooperative_id`
 * listo para guardar, o devuelve el motivo del rechazo.
 */
export async function revisarLaCooperativa(
  body: Record<string, unknown>,
  actual: { delivery_by?: string | null; cooperative_id?: string | null; city_id?: string | null },
): Promise<string | null> {
  if (!('delivery_by' in body) && !('cooperative_id' in body) && !('city_id' in body)) return null
  const reparte = 'delivery_by' in body ? String(body.delivery_by) : String(actual.delivery_by || 'local')
  if (reparte !== 'cooperativa') {
    if ('cooperative_id' in body && body.cooperative_id) {
      return 'Para elegir una cooperativa, «Quién reparte» tiene que ser «Una cooperativa»'
    }
    // Solo si cambia quién reparte: si no, el local sigue como estaba.
    if ('delivery_by' in body) body.cooperative_id = null
    return null
  }
  const id = 'cooperative_id' in body ? String(body.cooperative_id ?? '').trim() : String(actual.cooperative_id || '')
  if (!UUID_CIUDAD.test(id)) return 'Elige la cooperativa que reparte'
  const cooperativa = await db.getCooperative(id)
  if (!cooperativa) return 'Elige la cooperativa que reparte'
  if (!cooperativa.active) return 'Esa cooperativa está apagada'
  const ciudad = 'city_id' in body ? body.city_id : actual.city_id
  if (!ciudad || cooperativa.city_id !== ciudad) return 'La cooperativa tiene que ser de la ciudad del local'
  body.cooperative_id = id
  return null
}

export function assertDatabaseResult(result: DatabaseResult, operation: string): void {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido'
}

export function safeFailure(res: Response, context: string, error: unknown) {
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
export const seedBusinessCatalog = async (
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
export const cargarCartaDelLocal = async (
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
 * La ciudad del local al darlo de alta (2026-10-05).
 *
 * Después del alta y sin poder tumbarla, igual que los cajones: el negocio ya
 * existe. Devuelve un AVISO si se queda sin ciudad, porque así no aparece a
 * ningún cliente — se puede poner luego en su ficha, pero conviene saberlo.
 */
export const guardarCiudadDelLocal = async (businessId: string, valor: unknown): Promise<string | null> => {
  const ciudad = typeof valor === 'string' ? valor.trim() : ''
  if (!ciudad) return 'Sin ciudad: el local no aparecerá a los clientes hasta que se la pongas en su ficha'
  if (!UUID_CIUDAD.test(ciudad) || !(await db.getCity(ciudad))) return 'Ciudad no válida: ponla en su ficha'
  const result = await db.updateBusiness(businessId, { city_id: ciudad })
  return result.error ? `No se pudo guardar la ciudad: ${result.error.message || 'error'}` : null
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
export const guardarCajonesDelMenu = async (
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

export function usageLimitsForPlan(plan: PlanDefinition): UsageLimits {
  return {
    monthly_contact_limit: plan.monthlyContactLimit,
    monthly_outbound_message_limit: plan.monthlyOutboundMessageLimit,
  }
}

export function requestedPlan(body: Record<string, unknown>, fallback: PlanId): PlanDefinition | null {
  return getPlanDefinition('plan' in body ? body.plan : fallback)
}

// Dos negocios NUNCA pueden compartir el mismo identificador de canal: el bot
// resuelve a qué negocio pertenece cada mensaje por el número de WhatsApp o el
// slug de Telegram. La base lo bloquea; aquí se traduce a un mensaje entendible
// en vez del genérico "no se pudo actualizar".
export function duplicateChannelMessage(error: unknown): string | null {
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
