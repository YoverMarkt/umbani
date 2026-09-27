import type { SupabaseClient } from '@supabase/supabase-js'

// LA CONVERSACIÓN DEL MARKETPLACE
//
// Dónde está cada cliente dentro del marketplace: en qué local, en qué paso, y
// si ya empezó un pedido. Con un solo número para toda la plataforma, esto es
// lo que sustituye a «el teléfono dice de qué negocio es el mensaje».
//
// ⚠️ Es la única tabla sin `business_id`, porque la conversación ABARCA varios
// negocios. Por eso NUNCA se expone a una ruta de cliente: ahí se ve en qué
// local está comprando alguien, y una pizzería no puede saber que su cliente
// está pidiendo en la competencia. La base lo impide —solo `service_role`
// tiene acceso— y `tests/sql/verificar-aislamiento.sql` lo comprueba.

const db: SupabaseClient = require('../client') as typeof import('../client')

export interface MarketplaceConversation {
  id: string
  customer_id: string
  current_state: string
  selected_business_id: string | null
  shopping_locked: boolean
  flow_state: Record<string, unknown> | null
  version: number
  last_message_at: string
  expires_at: string | null
  /** La marca de la última lista enviada. Ver `marcarUltimaLista`. */
  menu_mark?: string | null
  /** La huella de la última respuesta y cuándo salió. Ver `anotarUltimaRespuesta`. */
  last_reply_hash?: string | null
  last_reply_at?: string | null
}

/** Lo que se quiere cambiar. Lo que no se nombra, no se toca. */
export interface ConversationPatch {
  state?: string
  businessId?: string
  /** Soltar el local: suelta también el bloqueo, que sin negocio no significa nada. */
  clearBusiness?: boolean
  shoppingLocked?: boolean
  flowState?: Record<string, unknown>
  clearFlow?: boolean
}

/**
 * El cliente detrás de un teléfono, sin negocio de por medio.
 *
 * ⚠️ Existe aparte de `resolveCustomer` (storefront.ts) porque aquel EXIGE un
 * `businessId` para dejar la fila en `business_customers`, y aquí todavía no
 * hay local: el cliente acaba de escribir a Umbani y aún no ha elegido. Crear
 * esa relación antes de que elija inventaría un vínculo con un negocio que
 * quizá nunca visite, y ese vínculo es justo lo que un local ve de sus
 * clientes.
 *
 * `customers` no lleva `business_id` —es de la plataforma, como esta misma
 * tabla— así que la consulta no necesita filtro de tenant. La relación con el
 * local se crea después, cuando lo elige.
 */
const resolveMarketplaceCustomer = async (
  phone: string,
): Promise<{ id: string; phone: string; name: string | null }> => {
  // Mismos dígitos que `resolveCustomer`: el mismo teléfono llega con `+` por
  // un canal y sin él por otro, y dos formas de escribirlo serían dos clientes.
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) throw new Error('El teléfono del cliente es obligatorio')

  const existing = await db
    .from('customers')
    .select('id,phone,name')
    .eq('phone', digits)
    .maybeSingle()
  if (existing.error) throw new Error(existing.error.message)
  if (existing.data) {
    return existing.data as { id: string; phone: string; name: string | null }
  }

  const created = await db
    .from('customers')
    .insert({ phone: digits, name: null })
    .select('id,phone,name')
    .single()
  if (created.error) throw new Error(created.error.message)
  return created.data as { id: string; phone: string; name: string | null }
}

const getConversation = async (
  customerId: string,
): Promise<MarketplaceConversation | null> => {
  const { data, error } = await db
    .from('marketplace_conversations')
    .select('*')
    .eq('customer_id', customerId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as MarketplaceConversation | null) ?? null
}

/**
 * Avanza la conversación en UNA operación, creándola si es el primer mensaje.
 *
 * `expectedVersion` es el bloqueo optimista: si otro proceso la movió mientras
 * tanto, devuelve `conflicto: true` y NO pisa nada — el llamador vuelve a leer
 * y decide. Sin versión, gana el último en escribir, que con dos mensajes
 * simultáneos del mismo cliente es una moneda al aire.
 */
const advanceConversation = async (
  customerId: string,
  patch: ConversationPatch = {},
  expectedVersion?: number,
): Promise<{ conflicto: true } | (MarketplaceConversation & { conflicto: false })> => {
  const { data, error } = await db.rpc('advance_marketplace_conversation', {
    p_customer_id: customerId,
    p_expected_version: expectedVersion ?? null,
    p_state: patch.state ?? null,
    p_business_id: patch.businessId ?? null,
    p_clear_business: patch.clearBusiness === true,
    p_shopping_locked: patch.shoppingLocked ?? null,
    p_flow_state: patch.flowState ?? null,
    p_clear_flow: patch.clearFlow === true,
  })
  if (error) throw new Error(error.message)
  return data as { conflicto: true } | (MarketplaceConversation & { conflicto: false })
}

/**
 * El ámbito de búsqueda se DERIVA, no se guarda.
 *
 * Un campo aparte podría contradecir a `selected_business_id`, y entonces
 * habría que decidir cuál de los dos miente.
 */
export type SearchScope = 'global' | 'current_business'

const searchScopeFor = (
  conversation: Pick<MarketplaceConversation, 'selected_business_id'> | null,
): SearchScope => (
  conversation?.selected_business_id ? 'current_business' : 'global'
)

/**
 * Borra la conversación de un cliente: la deja como si nunca hubiera escrito.
 *
 * ⚠️ NO es lo mismo que `MENÚ`, y por eso existe además de él. `MENÚ` suelta el
 * local y el carrito pero CONSERVA la fila, así que el cliente sigue siendo
 * conocido y su siguiente mensaje ya no es un primer contacto — que es
 * precisamente lo que decide si recibe la bienvenida o un «no te entendí»
 * (`paso(...)`, `primerContacto: !conversation`).
 *
 * ⚠️ Es del SIMULADOR, no del canal real. A un cliente de verdad no se le borra
 * la conversación: para él está `MENÚ`, que le deja salir sin perder quién es.
 * Aquí hace falta porque lo primero que hay que poder comprobar al dar de alta
 * un local es qué ve alguien que escribe a Umbani por primera vez.
 */
const deleteConversation = async (customerId: string): Promise<void> => {
  const { error } = await db
    .from('marketplace_conversations')
    .delete()
    .eq('customer_id', customerId)
  if (error) throw new Error(error.message)
}

/**
 * Apunta la marca de la lista que se le va a mandar al cliente.
 *
 * ⚠️ Nace del 2026-09-26: cada opción viajaba solo con su número de fila, y un
 * toque en una lista VIEJA se aplicaba a la pantalla de ahora — «Minimarkets»
 * acabó buscando «3» y «Jugos y batidos» entregó la carta de Monster Pizza.
 * Con la marca, el toque dice de QUÉ lista viene.
 *
 * ⚠️ Fuera del bloqueo optimista: NO sube `version`. Mandar una lista no cambia
 * el estado de la conversación, y si lo hiciera el siguiente `guardar` del
 * mismo turno chocaría consigo mismo.
 *
 * Devuelve si había conversación que marcar: sin fila, no hay nada contra lo
 * que comparar el toque y el llamador manda la lista sin marca.
 */
const marcarUltimaLista = async (customerId: string, marca: string): Promise<boolean> => {
  const { data, error } = await db
    .from('marketplace_conversations')
    .update({ menu_mark: marca })
    .eq('customer_id', customerId)
    .select('id')
  if (error) throw new Error(error.message)
  return Boolean(data?.length)
}

/**
 * Apunta la huella de la respuesta que se acaba de mandar, y cuándo.
 *
 * Es lo que deja contestar UNA vez a una ráfaga: veinte fotos seguidas daban
 * veinte respuestas idénticas (2026-09-26), y desde el 1 de octubre cada una se
 * paga. Tampoco sube `version`, por lo mismo que `marcarUltimaLista`.
 */
const anotarUltimaRespuesta = async (customerId: string, huella: string): Promise<void> => {
  const { error } = await db
    .from('marketplace_conversations')
    .update({ last_reply_hash: huella, last_reply_at: new Date().toISOString() })
    .eq('customer_id', customerId)
  if (error) throw new Error(error.message)
}

/**
 * ¿Se le contesta a este cliente, o ya se pasó del techo?
 *
 * El equivalente del marketplace a `claimMiniappReply`, que solo cubre el canal
 * PROPIO. Sin esto el número compartido responde sin límite, y desde el 1 de
 * octubre de 2026 cada respuesta se paga.
 *
 * ⚠️ Falla ABIERTO: un problema de la base no puede dejar mudo al marketplace
 * entero. Quedarse callado por un fallo nuestro deja sin servicio a clientes de
 * verdad; equivocarse al revés cuesta un mensaje.
 */
const claimMarketplaceReply = async (
  customerId: string,
  messageId?: string | null,
  limites?: { tope?: number; silencioHoras?: number },
): Promise<{ permitido: boolean; respuestas: number; aviso: boolean; hasta: string | null }> => {
  const { data, error } = await db.rpc('claim_marketplace_reply', {
    p_customer_id: customerId,
    p_tope: limites?.tope ?? 25,
    p_silencio_horas: limites?.silencioHoras ?? 12,
    p_message_id: messageId ?? null,
  })
  if (error) throw new Error(error.message)
  const reclamo = (data || {}) as {
    permitido?: boolean
    respuestas?: number
    aviso?: boolean
    hasta?: string | null
  }
  return {
    permitido: reclamo.permitido !== false,
    respuestas: Number(reclamo.respuestas) || 0,
    // Solo el mensaje que CRUZA el techo lo trae: es el único que se explica
    // (2026-09-27).
    aviso: reclamo.aviso === true,
    hasta: reclamo.hasta ?? null,
  }
}

/**
 * ¿Esta persona está bloqueada en TODA la plataforma? Y si acaba de volver de
 * un bloqueo por insultos, ¿toca decírselo?
 *
 * Distinto del bloqueo del dueño (`isContactBlocked`, por local). Este lo pone
 * el superadmin —o el chat, por insultos (2026-09-27)— y significa que Umbani
 * entero deja de atenderla.
 *
 * ⚠️ ESCRIBE, a diferencia de la consulta que sustituye: limpia el bloqueo de
 * 15 días que ya caducó y RECLAMA el aviso de vuelta, en la misma consulta,
 * para que salga una sola vez. Por eso el canario y el simulador la sustituyen.
 */
const claimPlatformBlockState = async (
  customerId: string,
): Promise<{ bloqueado: boolean; avisarDesbloqueo: boolean }> => {
  const { data, error } = await db.rpc('claim_platform_block_state', {
    p_customer_id: customerId,
  })
  if (error) throw new Error(error.message)
  const estado = (data || {}) as { bloqueado?: boolean; avisar_desbloqueo?: boolean }
  return {
    bloqueado: estado.bloqueado === true,
    avisarDesbloqueo: estado.avisar_desbloqueo === true,
  }
}

/**
 * Un insulto en el chat: la primera vez, advertencia; la siguiente, 15 días
 * fuera de toda la app. Lo decide la base en una sola consulta, con la fila
 * bloqueada: dos insultos seguidos no pueden dar dos advertencias.
 */
const registerInsult = async (
  customerId: string,
  dias = 15,
): Promise<{ accion: 'advertido' | 'bloqueado' | 'ya_bloqueado' | 'nada'; hasta: string | null }> => {
  const { data, error } = await db.rpc('register_insult', {
    p_customer_id: customerId,
    p_dias: dias,
  })
  if (error) throw new Error(error.message)
  const falta = (data || {}) as { accion?: string; hasta?: string | null }
  const accion = falta.accion === 'advertido' || falta.accion === 'bloqueado' || falta.accion === 'ya_bloqueado'
    ? falta.accion
    : 'nada'
  return { accion, hasta: falta.hasta ?? null }
}

/**
 * Los teléfonos bloqueados en toda la plataforma, para el panel del superadmin.
 *
 * ⚠️ Solo los VIGENTES: un bloqueo de 15 días que ya pasó no se enseña, aunque
 * la fila no se limpie hasta el próximo mensaje de esa persona.
 */
const getPlatformBlocked = async (): Promise<{
  phone: string
  blockedAt: string
  reason: string | null
  /** Hasta cuándo, o `null` si es permanente (el del superadmin). */
  until: string | null
  /** `insultos` lo puso el chat; `manual`, el superadmin. */
  kind: 'manual' | 'insultos'
}[]> => {
  const { data, error } = await db
    .from('customers')
    .select('phone,blocked_at,blocked_reason,blocked_until,blocked_kind')
    .not('blocked_at', 'is', null)
    .order('blocked_at', { ascending: false })
    .limit(500)
  if (error) throw new Error(error.message)
  const ahora = Date.now()
  return (data || [])
    .filter(row => !row.blocked_until || new Date(row.blocked_until).getTime() > ahora)
    .map(row => ({
      phone: row.phone,
      blockedAt: String(row.blocked_at),
      reason: row.blocked_reason,
      until: row.blocked_until,
      kind: row.blocked_kind === 'insultos' ? 'insultos' : 'manual',
    }))
}

/** Lo pone y lo quita el SUPERADMIN, nunca un dueño. */
const setPlatformBlocked = async (
  phone: string,
  blocked: boolean,
  reason?: string | null,
): Promise<{ phone: string; blocked: boolean }> => {
  const { data, error } = await db.rpc('set_platform_blocked', {
    p_phone: phone,
    p_blocked: blocked,
    p_reason: reason ?? null,
  })
  if (error) throw new Error(error.message)
  return data as { phone: string; blocked: boolean }
}

export {
  getConversation,
  advanceConversation,
  marcarUltimaLista,
  anotarUltimaRespuesta,
  deleteConversation,
  claimMarketplaceReply,
  claimPlatformBlockState,
  registerInsult,
  getPlatformBlocked,
  setPlatformBlocked,
  searchScopeFor,
  resolveMarketplaceCustomer,
}
