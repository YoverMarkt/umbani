// ── API del admin (servida por el dominio y compositor TypeScript del superadmin) ──
import { api } from '../../api/client'

export type AdminStats = {
  totalClients: number
  activeClients: number
  suspendedClients: number
  messagesToday: number
}

// Lista resumida (db.getAllBusinesses trae solo columnas básicas — ahorro de egress)
export type BusinessRow = {
  id: string
  slug: string
  name: string
  type: string | null
  whatsapp_number: string | null
  /** `marketplace` = sin canal propio; lo atiende el número de Umbani. */
  whatsapp_provider: string | null
  active: boolean
  bot_active: boolean
  suspended: boolean
  /** Las dos que deciden si el local sale en el menú del marketplace. */
  takes_orders: boolean
  storefront_enabled: boolean
  plan: string | null
  monthly_contact_limit: number | null
  monthly_outbound_message_limit: number | null
  created_at: string
  notes: string | null
}

/**
 * ¿Un cliente puede ENCONTRAR este local escribiendo al número de Umbani?
 *
 * Las mismas cuatro condiciones que `marketplace_categories_disponibles()` en
 * la base. Se escriben aquí una sola vez para que ninguna pantalla se invente
 * su propia versión: si el panel dijera «sí» y el menú no lo ofreciera, sería
 * exactamente la clase de decisión mostrada y no cumplida que ya costó cara.
 */
export const enElMarketplace = (c: BusinessRow): boolean => (
  c.active && !c.suspended && c.takes_orders && c.storefront_enabled
)

export type MonthlyUsageRow = {
  business_id: string
  period_start: string
  period_end: string
  active_contacts: number
  inbound_messages: number
  outbound_messages: number
  outbound_text_messages: number
  outbound_image_messages: number
  outbound_video_messages: number
  outbound_interactive_messages: number
  contact_limit: number | null
  outbound_message_limit: number | null
  contact_overage: number
  outbound_message_overage: number
  includes_history_estimate: boolean
}

export type ChannelStatus = 'ok' | 'silencio' | 'nunca_recibio' | 'sin_canal'

/**
 * La salud del canal de entrada.
 *
 * ⚠️ `platform` es lo que antes era una fila por local. Hay UN canal —el
 * número de Umbani— y el semáforo por negocio no podía verlo: los mensajes del
 * marketplace se encolan sin `business_id`, así que cada local salía «sin
 * mensajes» a las 12 h para siempre.
 *
 * `businesses` se conserva para los negocios con canal PROPIO. Hoy va vacío, y
 * eso es correcto, no un fallo.
 *
 * ⚠️ Se retiró `errorsByBusiness`: el tipo lo declaraba y ninguna pantalla lo
 * pintaba, y descartaba justo los errores de la plataforma (`business_id`
 * NULL), que son la mayoría. Los errores viven en su propia pantalla.
 */
export type ChannelHealth = {
  checkedAt: string
  silenceHours: number
  alert: boolean
  platform: {
    status: ChannelStatus
    lastInboundAt: string | null
    hoursSinceLastInbound: number | null
    detail: string
  }
  businesses: Array<{
    businessId: string
    name: string
    status: ChannelStatus
    lastInboundAt: string | null
    hoursSinceLastInbound: number | null
    detail: string
  }>
  recentFailures: Array<{
    provider: string
    status: number
    reason: string
    at: string
  }>
}

export type PlatformError = {
  id: string
  business_id: string | null
  category: 'canal' | 'ia' | 'envio' | 'servidor' | 'pagos'
  code: string | null
  message: string
  context: Record<string, unknown>
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

export const getPlatformErrors = (category?: string) => api<PlatformError[]>(
  `/api/admin/errors${category ? `?category=${encodeURIComponent(category)}` : ''}`,
)

export const getStats = () => api<AdminStats>('/api/admin/stats')
export const getChannelHealth = () => api<ChannelHealth>('/api/admin/channel-health')

// ── Bloqueo de PLATAFORMA ────────────────────────────────────────────
//
// ⚠️ NO es el bloqueo del dueño. Aquel lo pone un local y solo cierra ese local
// —que El Puerto te expulse no puede dejarte fuera de Umbani entero—. Este lo
// pone el superadmin: el bot deja de responder y NINGÚN local acepta el pedido,
// ni siquiera de mostrador.
export type PlatformBlock = {
  phone: string
  blockedAt: string
  reason: string | null
  /** Hasta cuándo; `null` = permanente (el del superadmin). */
  until: string | null
  /** `insultos` lo puso el chat solo (2026-09-27); `manual`, el superadmin. */
  kind: 'manual' | 'insultos'
}

export const getPlatformBlocked = () => api<PlatformBlock[]>('/api/admin/blocked')

export const setPlatformBlocked = (phone: string, blocked: boolean, reason?: string) =>
  api<{ phone: string; blocked: boolean }>(`/api/admin/blocked/${encodeURIComponent(phone)}`, {
    method: 'PUT', body: JSON.stringify({ blocked, reason }),
  })
export const getClients = () => api<BusinessRow[]>('/api/admin/clients')
export const getMonthlyUsage = (month?: string) => api<MonthlyUsageRow[]>(
  `/api/admin/usage${month ? `?month=${encodeURIComponent(month)}` : ''}`,
)

export const suspendClient = (id: string, reason?: string) =>
  api(`/api/admin/clients/${id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) })

export const reactivateClient = (id: string) =>
  api(`/api/admin/clients/${id}/reactivate`, { method: 'POST' })

// ⚠️ Aquí vivía `setBotActive`, retirada del panel el 2026-08-23.
//
// Encendía y apagaba `businesses.bot_active`, que solo lee
// `bot-conversation.ts` — el camino del canal PROPIO. Un local del marketplace
// no pasa por ahí: el botón prometía dejarlo mudo y no cortaba absolutamente
// nada. Para ocultar un local está «Aparece en el marketplace» en su ficha;
// para cortarle el servicio, Suspender.
//
// La ruta `/api/admin/clients/:id/bot` SIGUE VIVA y la columna intacta: los
// negocios con canal propio existen todavía en el código y ahí sí funciona.
// Lo que se retira es la pantalla que enseñaba una decisión sin cumplir.


// ── Detalle + crear/editar negocio (el corazón del onboarding) ──
export type BusinessDetail = BusinessRow & {
  /** Cajones del menú donde aparece: los elegidos, o los de su tipo. */
  marketplace_categories?: string[]
  owner_phone: string | null
  // 'marketplace' = sin canal propio; lo atiende el número de la plataforma.
  whatsapp_provider: 'ycloud' | 'meta' | 'telegram' | 'marketplace' | null
  ycloud_number: string | null
  ycloud_webhook_endpoint_id: string | null
  meta_phone_id: string | null
  takes_orders: boolean | null
  storefront_enabled: boolean | null
  /** Cobro con tarjeta (PayPhone). NULL = apagado. Solo lo toca el superadmin. */
  card_mode?: 'pruebas' | 'produccion' | null
  /** Quién lleva los pedidos: el local o los motorizados de Umbani. */
  delivery_by?: 'local' | 'umbani'
  monthly_rate: number | null
  client_email: string
  credential_status: Record<'ycloud_api_key' | 'ycloud_webhook_secret' | 'meta_token' | 'telegram_bot_token', boolean>
}

export type BusinessPayload = Omit<Partial<BusinessDetail>, 'credential_status'> & {
  ycloud_api_key?: string
  ycloud_webhook_secret?: string
  meta_token?: string
  telegram_bot_token?: string
  client_password?: string
  apply_plan_defaults?: boolean
  /** Solo al crear: la carta revisada ocupa el sitio de los productos de ejemplo. */
  carta?: CartaRevisada
}

// ── La carta del local (2026-09-24) ──────────────────────────────────────────
// Lo que la IA leyó de las fotos (`propuesta`) y lo que se manda al crear, ya
// revisado. Los precios dudosos llegan en `null`: se rellenan, no se adivinan.

export type CartaPropuesta = {
  categorias: {
    nombre: string
    productos: {
      nombre: string
      precio: number | null
      descripcion: string | null
      variantes: { nombre: string; precio: number | null }[]
      listas: { titulo: string; opciones: string[] }[]
    }[]
  }[]
  /** «Para llevar $3,50»: se enseña como aviso y no se usa. */
  otrosPrecios: { producto: string; texto: string }[]
}

export type CartaRevisada = {
  categorias: {
    nombre: string
    productos: {
      nombre: string
      precio: number | null
      descripcion: string | null
      variantes: { nombre: string; precio: number | null }[]
      listas: { titulo: string; opciones: string[]; obligatoria: boolean }[]
    }[]
  }[]
}

/** Manda las fotos de la carta a leer. No guarda nada: devuelve la propuesta. */
export const leerCarta = (fotos: File[]) => {
  const formulario = new FormData()
  fotos.forEach(foto => formulario.append('fotos', foto))
  return api<{ propuesta: CartaPropuesta }>('/api/admin/carta/leer', {
    method: 'POST',
    body: formulario,
  }).then(r => r.propuesta)
}

/** Lo que devuelve el alta: el negocio y, si hubo carta o cajones, cómo fue. */
export type AltaDeNegocio = BusinessRow & {
  carta?: { productos: number; variantes?: number }
  aviso?: string
}

export const getClient = (id: string) => api<BusinessDetail>(`/api/admin/clients/${id}`)

/** Cómo usa la gente el menú de Umbani: embudo, cajones y búsquedas. */
export type MarketplaceUsage = {
  dias: number
  embudo: { paso: string; orden: number; clientes: number }[]
  cajones: {
    code: string; label: string; entradas: number; eligieron: number; abandonaron: number
  }[]
  busquedas: { consulta: string; veces: number; sin_nada: number; entendido: string | null }[]
}

export const getMarketplaceUsage = (dias = 7) =>
  api<MarketplaceUsage>(`/api/admin/marketplace-usage?dias=${dias}`)

/** Un cajón del menú del chat: donde el cliente busca antojos. */
export type CajonDelMenu = { code: string; label: string; emoji: string | null }

/**
 * Los cajones del menú, TODOS, también los vacíos: el superadmin necesita ver
 * el cajón sin locales para poder meter ahí el primero.
 */
export const getMarketplaceCategories = () =>
  api<{ categories: CajonDelMenu[] }>('/api/admin/marketplace-categories')
    .then(r => r.categories)

export const createClient = (p: BusinessPayload) =>
  api<AltaDeNegocio>('/api/admin/clients', { method: 'POST', body: JSON.stringify(p) })

export const updateClient = (id: string, p: BusinessPayload) =>
  api(`/api/admin/clients/${id}`, { method: 'PUT', body: JSON.stringify(p) })

// ⚠️ Aquí vivía `verifyProvider` (y su tipo `ProviderVerificationPayload`).
// Verificaba credenciales TECLEADAS de un canal propio antes de guardarlas, y
// su único llamador —el bloque del canal en `ClientModal`— se retiró con el
// canal propio el 2026-08-23. La ruta `/api/admin/verify-provider` sigue en el
// servidor; lo que ya no existe es la pantalla desde la que se llamaba.

// ── Herramientas por negocio (paridad con el admin viejo) ──
export type ClientProduct = { id: string; name: string }
export type ClientMsg = { contact_phone: string; role: string; content: string; created_at: string }

export const getClientProducts = (id: string) =>
  api<ClientProduct[]>(`/api/admin/clients/${id}/products`)

export const getClientConversations = (id: string) =>
  api<ClientMsg[]>(`/api/admin/clients/${id}/conversations`)

// ⚠️ Aquí vivían `getClientPolicies` y `saveClientPolicies`, retiradas el
// 2026-09-20 con la tabla `bot_policies`: el saludo que guardaban no lo leía
// nadie y cada local se presenta desde Umbani.

// ⚠️ Aquí vivía `verifyClient`, retirada del panel el 2026-08-23.
//
// `/api/admin/clients/:id/verify` resuelve el proveedor con `providerFrom`,
// que solo conoce ycloud, meta y telegram. Con `whatsapp_provider =
// 'marketplace'` devolvía `null` y la respuesta era SIEMPRE «✗ Proveedor no
// reconocido», sin consultar nada — para todos los negocios de producción.
//
// La ruta sigue viva porque un negocio con canal propio sí se puede verificar.
// El número del MARKETPLACE tiene su propio verificador, que sí funciona:
// `/api/admin/verify-platform-channel`, en Ajustes del servidor.

export const deleteClient = (id: string) =>
  api(`/api/admin/clients/${id}`, { method: 'DELETE' })

// ── Motor de margen de la plataforma ─────────────────────────────────
//
// Lo que decide cuánto gana la plataforma con cada pedido. El importe lo
// calcula y sella PostgreSQL (regla inviolable #8); desde aquí solo se
// administran las reglas y se simula antes de activarlas.

export type MarkupTier = { up_to: number | null, amount: number }

export type PricingRule = {
  id: string
  business_id: string | null
  scope: 'global' | 'family' | 'business_type' | 'business'
  target_name: string | null
  strategy: 'percentage' | 'fixed' | 'tiered'
  percentage: number | null
  fixed_amount: number | null
  tiers: MarkupTier[] | null
  min_amount: number | null
  max_amount: number | null
  markup_mode: 'absorbed' | 'on_top'
  version: number
  status: 'active' | 'draft' | 'archived'
  notes: string | null
  created_at: string
  businesses?: { name: string } | null
}

/** Lo que se manda al crear o reemplazar. */
export type PricingRuleDraft = {
  scope: PricingRule['scope']
  business_id?: string | null
  target_name?: string | null
  strategy: PricingRule['strategy']
  percentage?: number | null
  fixed_amount?: number | null
  tiers?: MarkupTier[] | null
  min_amount?: number | null
  max_amount?: number | null
  markup_mode?: PricingRule['markup_mode']
  notes?: string | null
}

export type MarkupSimulation = {
  markup: number
  merchantSubtotal: number
  customerSubtotal: number
  markupMode: 'absorbed' | 'on_top'
}

export type MarkupSummaryRow = {
  business_id: string
  business_name: string
  pedidos: number
  bruto: number
  margen: number
  /** De quien entrega. Ni del local ni de la plataforma. */
  reparto: number
  /** Del local, por su comida. */
  productos: number
}

export type BusinessFamily = { code: string, label: string, sort: number }

/**
 * Las familias —hoy comida y retail—. Agrupan los 30 tipos clasificados: una
 * regla para «comida» cubre 24 —pizzería, hamburguesería, almuerzos, batidos…—
 * en vez de 24 reglas iguales.
 */
export const getBusinessFamilies = () => api<BusinessFamily[]>('/api/admin/business-families')

export const getPricingRules = () => api<PricingRule[]>('/api/admin/pricing-rules')

export const createPricingRule = (rule: PricingRuleDraft) =>
  api<PricingRule>('/api/admin/pricing-rules', {
    method: 'POST', body: JSON.stringify(rule),
  })

/** Reemplazar crea una VERSIÓN nueva y archiva la anterior. */
export const replacePricingRule = (id: string, rule: PricingRuleDraft) =>
  api<PricingRule>(`/api/admin/pricing-rules/${id}`, {
    method: 'PUT', body: JSON.stringify(rule),
  })

export const archivePricingRule = (id: string) =>
  api<{ ok: boolean }>(`/api/admin/pricing-rules/${id}`, { method: 'DELETE' })

/** Cuánto dejaría una regla ANTES de activarla (§42). */
export const simulateMarkup = (rule: PricingRuleDraft, subtotal: number) =>
  api<MarkupSimulation>('/api/admin/pricing-rules/simulate', {
    method: 'POST', body: JSON.stringify({ ...rule, subtotal }),
  })

export const getMarkupSummary = () =>
  api<MarkupSummaryRow[]>('/api/admin/pricing-summary')
