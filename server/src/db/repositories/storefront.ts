import type { SupabaseClient } from '@supabase/supabase-js'

// Datos de la mini app: clientes, sus direcciones y las sesiones del enlace.
// Todo filtra por business_id salvo `customers`, que es identidad global (una
// persona, un teléfono) y a la que solo se llega por teléfono, nunca listando.

const db: SupabaseClient = require('../client') as typeof import('../client')

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

// ── Clientes ────────────────────────────────────────────────────────────────

/**
 * El teléfono ES la identidad del cliente. Se resuelve o se crea, y de paso se
 * asegura su relación con el negocio: el negocio solo verá esa relación, nunca
 * que la persona también compra en otro sitio.
 */
const resolveCustomer = async (input: {
  businessId: string
  phone: string
  name?: string | null
}) => {
  const phone = String(input.phone || '').replace(/\D/g, '')
  if (!phone) throw new Error('El teléfono del cliente es obligatorio')

  const existing = await db
    .from('customers')
    .select('id,phone,name')
    .eq('phone', phone)
    .maybeSingle()
  fail(existing.error, 'No se pudo buscar el cliente')

  let customer = existing.data as { id: string; phone: string; name: string | null } | null
  if (!customer) {
    const created = await db
      .from('customers')
      .insert({ phone, name: input.name || null })
      .select('id,phone,name')
      .single()
    fail(created.error, 'No se pudo crear el cliente')
    customer = created.data as { id: string; phone: string; name: string | null }
  } else if (input.name && !customer.name) {
    // Solo se completa lo que falta: nunca se pisa un nombre ya guardado.
    await db.from('customers').update({ name: input.name }).eq('id', customer.id)
  }

  const link = await db
    .from('business_customers')
    .upsert(
      {
        business_id: input.businessId,
        customer_id: customer.id,
        display_name: input.name || null,
      },
      { onConflict: 'business_id,customer_id', ignoreDuplicates: true },
    )
  fail(link.error, 'No se pudo vincular el cliente con el negocio')
  return customer
}

/**
 * Guarda el nombre con el que este cliente pide EN ESTE negocio.
 *
 * ⚠️ Existe porque `ensureCustomer` no podía hacerlo: hace un `upsert` con
 * `ignoreDuplicates`, y la fila ya suele existir —la crea el bot al mandar el
 * enlace, sin nombre—, así que no escribía nada. Y aunque no existiera, en ese
 * momento el nombre todavía es nulo: se escribe después, en el checkout.
 * Resultado: 25 pedidos del mismo cliente y `display_name` en nulo, teniendo
 * la mini app la precarga ya construida y sin nada que precargar.
 *
 * Se llama al CREAR el pedido, que es cuando el nombre existe de verdad.
 */
const setCustomerDisplayName = async (
  businessId: string,
  customerId: string,
  name: string,
) => {
  const { error } = await db
    .from('business_customers')
    .update({ display_name: name, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
  // No se usa `fail`: que no se pueda recordar el nombre jamás puede tumbar un
  // pedido que la base ya aceptó. Quien llama decide, y hoy lo ignora.
  return { error: error || null }
}

const getBusinessCustomer = async (businessId: string, customerId: string) => {
  const { data, error } = await db
    .from('business_customers')
    .select('display_name,total_orders,total_spent,last_order_at,marketing_consent')
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .maybeSingle()
  fail(error, 'No se pudo leer el cliente del negocio')
  return data
}

// ── Direcciones ─────────────────────────────────────────────────────────────
// Guardadas por negocio a propósito: que un local vea a dónde pidió ese cliente
// en otro sería filtrar datos entre negocios.

/** Todo lo que la mini app y el repartidor necesitan de una dirección. */
const CAMPOS_DE_LA_DIRECCION =
  'id,label,address,reference,latitude,longitude,accuracy_m,building_type,courier_notes,is_default' as const

const getCustomerAddresses = async (businessId: string, customerId: string) => {
  const { data, error } = await db
    .from('customer_addresses')
    .select(CAMPOS_DE_LA_DIRECCION)
    .eq('business_id', businessId)
    .eq('customer_id', customerId)
    .eq('active', true)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
  fail(error, 'No se pudieron leer las direcciones')
  return data || []
}

/**
 * Cómo se compara una dirección con otra para saber si son LA MISMA.
 *
 * Sin tildes, sin mayúsculas y sin espacios de más: «Av. Amazonas  N34» y
 * «av. amazonas n34» son la misma casa escrita dos veces, y quien las teclea
 * en el móvil de una tienda no está pensando en eso.
 */
const mismaDireccion = (texto: string): string => texto
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()

const createCustomerAddress = async (input: {
  businessId: string
  customerId: string
  label?: string
  address: string
  reference?: string | null
  latitude?: number | null
  longitude?: number | null
  accuracyM?: number | null
  buildingType?: string | null
  courierNotes?: string | null
  isDefault?: boolean
}) => {
  // ── LA MISMA CASA NO SE GUARDA DOS VECES ─────────────────────────────────
  //
  // ⚠️ Esto no es pulcritud: es la red que faltaba bajo un fallo real. Si la
  // app no consigue leer la libreta del cliente —un 401 al arrancar, la sesión
  // que se estrena, la red— le enseña «no tienes direcciones» y la persona
  // escribe la suya otra vez. El resultado, medido en producción el
  // 2026-08-29: **12 direcciones para un cliente, siete de ellas borradas a
  // mano por él**, y la misma calle repetida cinco veces.
  //
  // La app ya se arregló para recargar quién es al estrenar sesión, pero esa
  // defensa vive en el teléfono. Esta vive DONDE SE ESCRIBE, así que aguanta
  // aunque el frontend falle por un motivo que nadie ha previsto todavía.
  //
  // Reutilizar en vez de rechazar: quien manda esto cree que está guardando su
  // dirección, y devolverle la que ya tenía es exactamente lo que esperaba —
  // con su id, que es lo que el checkout necesita para dejarla elegida.
  //
  // ⚠️ Solo mira las ACTIVAS. Una que el cliente borró y vuelve a escribir es
  // una decisión suya de recuperarla, no un duplicado.
  const existentes = await getCustomerAddresses(input.businessId, input.customerId)
  const repetida = (existentes as { id: string; address?: string | null }[])
    .find(item => mismaDireccion(String(item.address || '')) === mismaDireccion(input.address))

  if (repetida) {
    // Se refresca lo que SÍ puede haber mejorado: el pin, la referencia y cómo
    // la llama. Un cliente que vuelve a escribirla suele estar corrigiendo algo.
    const { data, error } = await db
      .from('customer_addresses')
      .update({
        label: input.label || 'Casa',
        reference: input.reference || null,
        // El pin solo se pisa si viene uno nuevo: perder el que ya estaba
        // porque esta vez el navegador negó el permiso sería un paso atrás.
        ...(input.latitude != null && input.longitude != null
          ? { latitude: input.latitude, longitude: input.longitude, accuracy_m: input.accuracyM ?? null }
          : {}),
        building_type: input.buildingType ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('business_id', input.businessId)
      .eq('customer_id', input.customerId)
      .eq('id', repetida.id)
      .select(CAMPOS_DE_LA_DIRECCION)
      .single()
    fail(error, 'No se pudo guardar la dirección')
    return data
  }

  const { data, error } = await db
    .from('customer_addresses')
    .insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      label: input.label || 'Casa',
      address: input.address,
      reference: input.reference || null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      accuracy_m: input.accuracyM ?? null,
      building_type: input.buildingType ?? null,
      courier_notes: input.courierNotes ?? null,
      is_default: Boolean(input.isDefault),
    })
    .select(CAMPOS_DE_LA_DIRECCION)
    .single()
  fail(error, 'No se pudo guardar la dirección')
  return data
}

/**
 * Retira una dirección de la libreta del cliente.
 *
 * Se marca `active = false` en vez de borrarla, y no es prudencia genérica:
 * `orders.address_id` apunta aquí. Borrarla de verdad dejaría ese puntero en
 * nulo y se perdería a qué casa pide más un cliente —lo único para lo que
 * sirve ya ese puntero, porque el destino del pedido va congelado aparte—.
 *
 * El `where` lleva negocio Y cliente: una dirección ajena no se retira ni
 * sabiendo su id. Devuelve `null` si no era suya, y quien llama responde 404.
 */
const deactivateCustomerAddress = async (input: {
  businessId: string
  customerId: string
  addressId: string
}) => {
  const { data, error } = await db
    .from('customer_addresses')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('business_id', input.businessId)
    .eq('customer_id', input.customerId)
    .eq('id', input.addressId)
    .eq('active', true)
    .select('id')
    .maybeSingle()
  fail(error, 'No se pudo eliminar la dirección')
  return data || null
}

/**
 * Le pone el pin a una dirección que ya existe.
 *
 * Hace falta porque las direcciones guardadas antes de esto no tienen
 * coordenadas: sin esta puerta, un cliente con su «7 de agosto» de siempre no
 * podría añadírselas nunca y su repartidor seguiría buscando a ciegas.
 *
 * El `where` lleva negocio Y cliente: una dirección ajena no se mueve ni
 * sabiendo su id. Devuelve `null` si no era suya, y quien llama responde 404.
 */
const setCustomerAddressLocation = async (input: {
  businessId: string
  customerId: string
  addressId: string
  latitude: number
  longitude: number
  accuracyM?: number | null
}) => {
  const { data, error } = await db
    .from('customer_addresses')
    .update({
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy_m: input.accuracyM ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('business_id', input.businessId)
    .eq('customer_id', input.customerId)
    .eq('id', input.addressId)
    .eq('active', true)
    .select(CAMPOS_DE_LA_DIRECCION)
    .maybeSingle()
  fail(error, 'No se pudo guardar la ubicación')
  return data || null
}

// ── Sesiones del enlace ─────────────────────────────────────────────────────

const createStorefrontSession = async (input: {
  businessId: string
  customerId: string
  tokenHash: string
  contactPhone: string
  expiresAt: string | null
}) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .insert({
      business_id: input.businessId,
      customer_id: input.customerId,
      token_hash: input.tokenHash,
      contact_phone: String(input.contactPhone || '').replace(/\D/g, ''),
      expires_at: input.expiresAt,
    })
    .select('id,expires_at')
    .single()
  fail(error, 'No se pudo crear la sesión de la tienda')
  return data
}

/** Se busca SIEMPRE por hash: el token en claro no vive en la base. */
const getStorefrontSessionByHash = async (tokenHash: string) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .select('id,business_id,customer_id,contact_phone,device_hash,claimed_at,expires_at,revoked_at,verified_at')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  fail(error, 'No se pudo leer la sesión')
  return data
}

/**
 * Ata la sesión al primer dispositivo que la abre. La condición
 * `is('device_hash', null)` hace la operación atómica: si dos dispositivos
 * abren el mismo enlace a la vez, solo uno se la queda.
 */
const claimStorefrontSession = async (sessionId: string, deviceHash: string) => {
  const { data, error } = await db
    .from('storefront_sessions')
    .update({ device_hash: deviceHash, claimed_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('device_hash', null)
    .select('id')
  fail(error, 'No se pudo reclamar la sesión')
  return (data || []).length === 1
}

const touchStorefrontSession = async (sessionId: string) => {
  await db
    .from('storefront_sessions')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', sessionId)
}
const cleanupStorefrontSessions = async (days = 2) => db.rpc(
  'cleanup_storefront_sessions',
  { p_days: days },
)

/**
 * Un enlace vivo a la vez: al emitir uno se revocan los demás de esa persona.
 *
 * ⚠️ Dos excepciones, y las decide la RPC porque son una sola pregunta a la
 * base: el local que se acaba de entregar (matar su sesión vaciaría el carrito
 * que la persona tiene abierto) y cualquier local donde quede un pedido en
 * `esperando_pago` (los datos bancarios viven detrás de la sesión).
 *
 * Devuelve cuántos cayeron. Falla hacia NO revocar.
 */
/**
 * Cancela el pedido sin pagar de esta persona en este local.
 *
 * Solo se llama cuando el cliente dice en voz alta que lo deja («Empezar de
 * nuevo»). Cancelar y caducar no significan lo mismo: caducar es que se acabó
 * el tiempo, cancelar es que alguien decidió — y el historial del dueño tiene
 * que poder distinguirlo.
 *
 * ⚠️ No cuenta como impago: irse avisando no puede costar lo mismo que
 * desaparecer, o nadie avisaría.
 */
const cancelUnpaidOrderOnPurpose = async (
  businessId: string,
  customerId: string,
): Promise<number> => {
  const { data, error } = await db.rpc('cancel_unpaid_order_on_purpose', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  fail(error, 'No se pudo cancelar el pedido')
  return Number(data ?? 0)
}

const revokeOtherStorefrontSessions = async (
  customerId: string,
  keepSessionId: string,
): Promise<number> => {
  const { data, error } = await db.rpc('revoke_other_storefront_sessions', {
    p_customer_id: customerId,
    p_keep_session_id: keepSessionId,
  })
  fail(error, 'No se pudieron revocar los enlaces anteriores')
  return Number(data ?? 0)
}

/**
 * Deja vivo SOLO el enlace indicado, incluido dentro del mismo local.
 *
 * Es la versión estricta de `revokeOtherStorefrontSessions`, y la usa
 * «Seguir mi pedido» (2026-09-16). La otra perdona todas las sesiones del local
 * vigente para no vaciar un carrito abierto; aquí eso sobra, porque quien
 * escribe en el chat ya cerró la tienda —el navegador de WhatsApp se cierra al
 * volver— y su carrito se fue con ella.
 *
 * ⚠️ El local que DEBE dinero no cede: lo decide la RPC en la misma consulta.
 */
const revokeStorefrontSessionsExcept = async (
  customerId: string,
  keepSessionId: string,
): Promise<number> => {
  const { data, error } = await db.rpc('revoke_storefront_sessions_except', {
    p_customer_id: customerId,
    p_keep_session_id: keepSessionId,
  })
  fail(error, 'No se pudieron revocar los enlaces anteriores')
  return Number(data ?? 0)
}

/**
 * Revoca los enlaces de un cliente AL SALIR —MENÚ o «Empezar de nuevo»— salvo
 * los de un local donde aún tenga un pedido esperando pago o en revisión.
 *
 * ⚠️ Nace de una prueba del dueño (2026-09-03): escribió MENÚ, recibió las
 * categorías… y el botón «Ver la carta» de arriba **seguía abriendo el local
 * anterior**. Sus palabras: «todo lo de la palabra menú hacia arriba debería
 * morirse». MENÚ suelta el candado de «un pedido a la vez», y por un enlace
 * viejo se podía armar un pedido en un local mientras se navegaba otro.
 *
 * ⚠️ Y se rehízo el 2026-09-27 por la EXCEPCIÓN. Quien debe un comprobante o
 * lo tiene en revisión conserva su enlace —ahí manda la captura y ve cómo va lo
 * suyo—, pero eso se decidía con el estado del CHAT leído antes de que MENÚ
 * cancelara el pedido. Al amigo del dueño le canceló el #25 y le dejó el
 * enlace vivo: volvió a entrar a La Abuelita un minuto después. Ahora lo
 * decide la base mirando los PEDIDOS tal como quedaron, en la misma consulta
 * (`revoke_storefront_sessions_on_exit`).
 *
 * Devuelve cuántas revocó. No lanza si no había ninguna: MENÚ se escribe
 * muchas veces sin tener enlace abierto.
 */
const revokeStorefrontSessionsOnExit = async (customerId: string): Promise<number> => {
  if (!customerId) return 0
  const { data, error } = await db.rpc('revoke_storefront_sessions_on_exit', {
    p_customer_id: customerId,
  })
  fail(error, 'No se pudieron revocar los enlaces del cliente')
  return Number(data ?? 0)
}

// El pedido de la tienda: la RPC resuelve cada precio desde la base. Aquí solo
// se traducen los nombres de los parámetros.
const createStorefrontOrder = async (input: {
  businessId: string
  customerId: string | null
  contactPhone: string
  contactName?: string | null
  addressId?: string | null
  fulfillment?: string | null
  paymentMethod?: string | null
  items: unknown[]
  /** Clave del intento de compra: dos envíos con la misma son UN pedido. */
  idempotencyKey?: string | null
  /** Para cuándo lo quiere el cliente. Nulo = lo antes posible. */
  scheduledFor?: string | null
  /** Instrucciones del cliente para ESTE pedido: «llame al llegar». */
  deliveryNotes?: string | null
}) => db.rpc('create_storefront_order', {
  p_business_id: input.businessId,
  p_customer_id: input.customerId,
  p_contact_phone: input.contactPhone,
  p_contact_name: input.contactName || null,
  p_address_id: input.addressId || null,
  p_fulfillment: input.fulfillment || null,
  p_items: input.items,
  p_idempotency_key: input.idempotencyKey || null,
  p_scheduled_for: input.scheduledFor || null,
  p_payment_method: input.paymentMethod || null,
  p_notes: input.deliveryNotes || null,
})

/**
 * El dinero OFICIAL del pedido, leído de la fila ya sellada.
 *
 * ⚠️ Existe porque `create_storefront_order` devuelve su propia cuenta
 * —`subtotal + envío`— y esa cuenta se queda CORTA: el disparador
 * `orders_stamp_pricing` corre después (BEFORE UPDATE) y, en modo `on_top`,
 * suma el margen de la plataforma al total. El resultado era que la app
 * enseñaba $12.99 sobre un pedido que la base guardaba en $14.09, y ese es el
 * número que el cliente iba a transferir: pagaba $1.10 de menos en cada
 * pedido, y el descuadre lo comía el negocio.
 *
 * Se lee la fila en vez de recrear la RPC a propósito: la regla del proyecto
 * es no tocar las funciones del dinero por algo que se resuelve fuera, porque
 * copiar la versión equivocada desde `schema.sql` cuesta más de lo que arregla.
 *
 * Sin `contact_phone` en el filtro porque lo llama la ruta que ACABA de crear
 * el pedido con esos datos; el id es de un pedido recién nacido y el negocio
 * ya está comprobado.
 *
 * ⚠️ Trae también el `status`, y por la misma razón: la RPC NO lo devuelve.
 * La ruta preguntaba `result.data.status === 'esperando_pago'` para pedir el
 * comprobante por el chat, siempre daba falso, y ese aviso no salió ni una
 * vez desde que se construyó (#283 → 2026-09-27: 0 en la cola de producción).
 */
const getOrderMoney = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .select('subtotal,shipping,total,status,payment_method')
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  if (error || !data) return null
  return data as {
    subtotal: number | string | null
    shipping: number | string | null
    total: number | string | null
    status: string | null
    payment_method: string | null
  }
}

/**
 * Registra la huella del comprobante y avisa si esa imagen ya se usó.
 *
 * ⚠️ La búsqueda de duplicados es GLOBAL —un comprobante reutilizado en otro
 * local es el fraude que más importa cazar—, pero la RPC nunca devuelve datos
 * del otro negocio: solo dice que ya se usó. Por eso vive en una función
 * `security definer` y no en una consulta desde aquí.
 */
const registerPaymentReceipt = async (input: {
  businessId: string
  orderId: string
  fileUrl: string
  filePublicId?: string | null
  sha256: string
  perceptualHash?: string | null
  mimeType?: string | null
  fileSize?: number | null
}) => db.rpc('register_payment_receipt', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_file_url: input.fileUrl,
  p_file_public_id: input.filePublicId || null,
  p_sha256: input.sha256,
  p_perceptual_hash: input.perceptualHash || null,
  p_mime_type: input.mimeType || null,
  p_file_size: input.fileSize ?? null,
})

/**
 * Guarda lo que la visión leyó del comprobante, sus señales y su score.
 *
 * ⚠️ El score lo calcula la BASE sumando todas las señales del comprobante, no
 * el servidor: `register_payment_receipt` ya dejó escrita la del duplicado
 * ANTES de que el análisis existiera, y un total calculado aquí la perdería.
 *
 * ⚠️ Y no confirma ningún pago: la RPC no escribe una sola columna de `orders`.
 */
const saveReceiptAnalysis = async (input: {
  businessId: string
  receiptId: string
  status: 'analizado' | 'requiere_revision'
  datos?: Record<string, unknown> | null
  flags?: Array<Record<string, unknown>> | null
  analysis?: Record<string, unknown> | null
  /** Los puntos de la señal de referencia repetida, configurables en Ajustes. */
  puntosReferencia?: number
}) => db.rpc('save_receipt_analysis', {
  p_business_id: input.businessId,
  p_receipt_id: input.receiptId,
  p_status: input.status,
  p_datos: input.datos ?? null,
  p_flags: input.flags ?? null,
  p_analysis: input.analysis ?? null,
  p_puntos_referencia: input.puntosReferencia ?? 60,
})

/**
 * El análisis del comprobante más reciente de un pedido, para el panel.
 *
 * El filtro por negocio va DENTRO de la función: el identificador del pedido
 * viaja en la URL, y sin el negocio se estaría enseñando el comprobante de
 * otro local.
 */
const getReceiptAnalysis = async (businessId: string, orderId: string) => {
  const { data, error } = await db.rpc('get_receipt_analysis', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  fail(error, 'No se pudo leer el análisis del comprobante')
  return (data || null) as Record<string, unknown> | null
}

// El comprobante lo sube el cliente desde la mini app, sin JWT: la RPC
// comprueba negocio + pedido + teléfono de la sesión antes de guardarlo.
const attachStorefrontPaymentProof = async (input: {
  businessId: string
  orderId: string
  contactPhone: string
  url: string
  /** Sin él no se puede firmar el acceso temporal al comprobante. */
  publicId?: string | null
}) => db.rpc('attach_storefront_payment_proof', {
  p_business_id: input.businessId,
  p_order_id: input.orderId,
  p_contact_phone: input.contactPhone,
  p_url: input.url,
  p_public_id: input.publicId || null,
})

/**
 * ¿Le toca a este cliente recibir el enlace de la mini app?
 *
 * La decisión y la marca van juntas dentro de PostgreSQL: si el cliente manda
 * tres mensajes seguidos —pasa constantemente— solo uno se lleva el envío.
 * Hacerlo en dos pasos desde aquí dejaría esa carrera abierta.
 */
const claimStorefrontLinkSend = async (
  businessId: string,
  customerId: string,
  cooldownHours = 24,
): Promise<boolean> => {
  const { data, error } = await db.rpc('claim_storefront_link_send', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_cooldown_hours: cooldownHours,
  })
  fail(error, 'No se pudo comprobar el envío del enlace')
  return data === true
}

// ── Quien escribe por molestar ─────────────────────────────────────────────

/**
 * ¿Se le contesta a este cliente, y cómo?
 *
 * Todo dentro de PostgreSQL y en una sola operación: contar aquí y escribir
 * después deja una carrera con los mensajes que llegan a la vez, que es justo
 * lo que hace quien escribe rápido para molestar.
 *
 * Nunca lanza hacia arriba con un `permitido: false`: si la base falla se
 * prefiere contestar. Quedarse callado por un fallo nuestro deja sin atender a
 * un cliente de verdad, y eso cuesta más que un mensaje de más.
 */
const claimMiniappReply = async (
  businessId: string,
  customerId: string,
  limites: {
    avisoDesde?: number
    tope?: number
    silencioHoras?: number
    /** El mensaje entrante que provocó la respuesta, para no contarlo dos veces. */
    mensajeId?: string | null
  } = {},
): Promise<{
  /** `false` = no se le contesta: está bloqueado o silenciado. */
  permitido: boolean
  motivo: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
  /** Cuántas van en esta hora, con esta incluida. */
  respuestas: number
}> => {
  const { data, error } = await db.rpc('claim_miniapp_reply', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_aviso_desde: limites.avisoDesde ?? 5,
    p_tope: limites.tope ?? 10,
    p_silencio_horas: limites.silencioHoras ?? 24,
    p_message_id: limites.mensajeId || null,
  })
  fail(error, 'No se pudo comprobar el ritmo de respuestas')
  const respuesta = (data || {}) as {
    permitido?: boolean
    motivo?: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
    respuestas?: number
  }
  return {
    permitido: respuesta.permitido !== false,
    motivo: respuesta.motivo || 'ok',
    respuestas: Number(respuesta.respuestas) || 0,
  }
}

/**
 * ¿Este teléfono está bloqueado en este negocio?
 *
 * ⚠️ Se normaliza a dígitos porque `customers.phone` se guarda así, y el bot
 * recibe el número con «+» (`+593…`). Buscar sin normalizar no falla: devuelve
 * vacío, que aquí significaría «no está bloqueado» — el peor fallo posible
 * para un bloqueo.
 */
/**
 * Lo que hay que saber de un bloqueo para poder explicarlo.
 *
 * ⚠️ El tipo va ESCRITO EN LÍNEA y no como `interface` con nombre: este
 * archivo termina en `export =`, que no admite otros `export`, y sin exportar
 * el nombre TypeScript no puede describir `db` para quien lo importa
 * («cannot be named», TS4023). Escrito así viaja estructuralmente y no hay
 * nada que exportar.
 */
type EstadoDeBloqueo = {
  blocked: boolean
  /** Del dueño: no caduca, y por eso no promete plazo. */
  permanent: boolean
  /** Hasta cuándo, solo en los temporales que siguen vigentes. */
  until: string | null
}

const SIN_BLOQUEO = { blocked: false, permanent: false, until: null }

/**
 * El estado del bloqueo de esta persona en este local.
 *
 * ⚠️ Lo responde la BASE (`storefront_customer_block_state`) y no TypeScript,
 * y ese es el arreglo entero del 2026-08-29. Aquí vivía una segunda regla
 * —`Boolean(blocked_at)`— que se contradecía con la del disparador de pedidos:
 * con un bloqueo temporal ya VENCIDO el chat decía «bloqueado» y la base
 * dejaba insertar. Por esa grieta entró el pedido #74. Ahora solo hay una
 * respuesta, y la da quien también decide si el `insert` pasa.
 *
 * ⚠️ Falla ABIERTO (`SIN_BLOQUEO`): dejar fuera a un cliente legítimo por un
 * fallo nuestro es peor que dejar entrar a un bloqueado, que además choca
 * contra el disparador al confirmar.
 */
const customerBlockState = async (
  businessId: string,
  customerId: string,
): Promise<{ blocked: boolean; permanent: boolean; until: string | null }> => {
  if (!businessId || !customerId) return SIN_BLOQUEO
  const { data, error } = await db.rpc('storefront_customer_block_state', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  if (error) return SIN_BLOQUEO
  const estado = (data || {}) as Partial<EstadoDeBloqueo>
  return {
    blocked: estado.blocked === true,
    permanent: estado.permanent === true,
    until: estado.until ?? null,
  }
}

/** El mismo estado, pero llegando por el TELÉFONO — que es lo que trae el chat. */
const contactBlockState = async (
  businessId: string,
  phone: string,
): Promise<{ blocked: boolean; permanent: boolean; until: string | null }> => {
  const digitos = String(phone || '').replace(/\D/g, '')
  if (!businessId || !digitos) return SIN_BLOQUEO
  const { data, error } = await db
    .from('business_customers')
    .select('customer_id,customers!inner(phone)')
    .eq('business_id', businessId)
    .eq('customers.phone', digitos)
    .maybeSingle()
  if (error) return SIN_BLOQUEO
  const customerId = (data as { customer_id?: string } | null)?.customer_id
  if (!customerId) return SIN_BLOQUEO
  return customerBlockState(businessId, customerId)
}

const isContactBlocked = async (businessId: string, phone: string): Promise<boolean> => (
  (await contactBlockState(businessId, phone)).blocked
)

/**
 * La regla de margen vigente para este negocio, o `null` si no hay ninguna.
 *
 * Sale de `business_pricing_view`, que aplica la MISMA jerarquía que usa el
 * cobro (negocio → tipo → global): reimplementarla aquí daría dos respuestas
 * a la misma pregunta, y una de las dos acabaría cobrando distinto.
 *
 * ⚠️ Falla hacia `null` —sin margen— y no hacia un porcentaje inventado: si la
 * consulta revienta, el cliente ve el precio del comercio. Equivocarse hacia
 * NO cobrar de más es el único lado seguro de este error.
 */
const getBusinessPricingRule = async (
  businessId: string,
): Promise<Record<string, unknown> | null> => {
  if (!businessId) return null
  const { data, error } = await db.rpc('business_pricing_view', {
    p_business_id: businessId,
  })
  if (error) return null
  return (data as Record<string, unknown> | null) ?? null
}

/**
 * ¿Toca EXPLICARLE el bloqueo a este cliente? Una sola vez.
 *
 * Devuelve `true` en su primer intento tras ser bloqueado y `false` en todos
 * los siguientes, así el bloqueado nunca cuesta más mensajes que un cliente
 * normal — que es lo que pasaría avisando cada vez, porque quien molesta
 * insiste.
 *
 * ⚠️ Falla hacia el SILENCIO (`false`): ante un fallo de la base se manda el
 * mensaje neutro de siempre, que es la conducta anterior a esto. Al revés
 * —avisar por defecto— un fallo repetido convertiría el bloqueo en una fuente
 * de mensajes pagados.
 */
const claimBlockedNotice = async (
  businessId: string,
  customerId: string,
): Promise<boolean> => {
  if (!businessId || !customerId) return false
  const { data, error } = await db.rpc('claim_blocked_notice', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  if (error) return false
  return data === true
}

/**
 * Lo mismo cuando ya se sabe QUIÉN es: el camino de la mini app.
 *
 * ⚠️ Pregunta a la BASE, como todo lo demás desde el 2026-08-29. Aquí vivía
 * una copia de la regla (`estaBloqueado`) y esa fue la tercera de cuatro: cada
 * copia acaba contestando distinto, y esta decide si un pedido se crea.
 */
const isCustomerBlocked = async (businessId: string, customerId: string): Promise<boolean> => (
  (await customerBlockState(businessId, customerId)).blocked
)

/**
 * Los contactos bloqueados AHORA de un negocio, con su plazo.
 *
 * Se consultan aparte y no dentro de la lista de conversaciones a propósito:
 * son POCOS —y en casi todos los negocios, ninguno—, mientras que la lista de
 * chats se pide cada pocos segundos.
 *
 * ⚠️ Lo calcula la BASE (`business_blocked_contacts`), que a su vez llama a
 * `storefront_customer_block_state` fila por fila. Aquí había un
 * `.not('blocked_at', 'is', null)` —la CUARTA copia de la regla— y mentía: el
 * bloqueo temporal también pone `blocked_at`, así que a los 30 minutos el
 * cliente ya podía pedir y el panel seguía diciendo «Bloqueado» para siempre.
 * Lo vio el dueño mirando su pantalla de Clientes el 2026-08-29.
 *
 * ⚠️ Devuelve el PLAZO además del teléfono: es lo que deja al panel distinguir
 * «Bloqueado por ti» de «Bloqueado 20 min», que son dos cosas distintas — una
 * la levanta el dueño y la otra se va sola.
 */
const getBlockedContacts = async (businessId: string): Promise<{
  phone: string
  until: string | null
  permanent: boolean
}[]> => {
  if (!businessId) return []
  const { data, error } = await db.rpc('business_blocked_contacts', {
    p_business_id: businessId,
  })
  fail(error, 'No se pudieron leer los números bloqueados')
  const filas = (data || []) as {
    phone?: string | null
    until?: string | null
    permanent?: boolean | null
  }[]
  return filas
    .map(fila => ({
      phone: String(fila.phone || '').trim(),
      until: fila.until ?? null,
      permanent: fila.permanent === true,
    }))
    .filter(fila => Boolean(fila.phone))
}

/**
 * El dueño bloquea o desbloquea un número desde su panel.
 *
 * Crea el cliente si no existía: quien escribe por molestar puede no haber
 * pedido nunca, y es justo a ese al que hay que poder bloquear.
 *
 * Desbloquear limpia TAMBIÉN el silencio automático y el contador: si el dueño
 * decide dar otra oportunidad, empieza de cero. Dejarle el silencio puesto
 * haría que el desbloqueo pareciera no funcionar durante horas.
 */
const setContactBlocked = async (
  businessId: string,
  phone: string,
  bloqueado: boolean,
): Promise<{ blocked: boolean }> => {
  const customer = await resolveCustomer({ businessId, phone })
  const ahora = new Date().toISOString()
  const { error } = await db
    .from('business_customers')
    .update(bloqueado
      // ⚠️ `blocked_until: null` al BLOQUEAR, y es un arreglo, no una limpieza
      // de cortesía (2026-08-29). Sin él, bloquear a quien tuvo un bloqueo
      // automático antes NO surtía efecto: la regla dice que un bloqueo es
      // permanente cuando `blocked_at` está puesto Y `blocked_until` es nulo,
      // así que con un `blocked_until` vencido no era ni permanente ni
      // temporal — el dueño pulsaba «Bloquear», el panel le decía «Cliente
      // bloqueado», y esa persona seguía pudiendo pedir. La decisión del dueño
      // manda sobre cualquier automático pendiente.
      ? { blocked_at: ahora, blocked_until: null, updated_at: ahora }
      // Desbloquear limpia también `blocked_notified_at`: si el dueño lo
      // vuelve a bloquear más adelante, esa es una decisión NUEVA y merece su
      // propia explicación.
      //
      // ⚠️ Y `blocked_until`, por lo mismo al revés: sin él, desbloquear a
      // quien tenía un temporal vigente lo dejaba bloqueado igual mientras el
      // panel ya lo mostraba libre. Cuando el dueño perdona, perdona entero.
      // ⚠️ Y los DOS contadores a cero (2026-09-03). Sin esto, el dueño
      // levantaba el bloqueo y el cliente seguía a UN paso del siguiente: con
      // `unpaid_expiries` en 4 y el límite en 2, el próximo pedido que se le
      // caducara lo bloqueaba otra vez, media hora, y otra vez, y otra. El
      // perdón duraba hasta el primer tropiezo, que no es perdonar.
      : {
        blocked_at: null, blocked_until: null, blocked_notified_at: null,
        muted_until: null, reply_count: 0, reply_window_start: null,
        unpaid_expiries: 0, rejected_receipts: 0,
        updated_at: ahora,
      })
    .eq('business_id', businessId)
    .eq('customer_id', customer.id)
  fail(error, 'No se pudo actualizar el bloqueo')
  return { blocked: bloqueado }
}

/**
 * Ata la sesión a ESTE dispositivo tras confirmar el número.
 *
 * A diferencia de `claimStorefrontSession`, no exige que el dispositivo esté
 * libre: es justo lo que permite que el cliente vuelva a entrar desde un móvil
 * nuevo, o recupere su enlace si alguien lo abrió antes que él. Quien no sepa
 * el número no llega hasta aquí.
 */
const bindStorefrontSession = async (sessionId: string, deviceHash: string) => {
  const ahora = new Date().toISOString()
  const { data, error } = await db
    .from('storefront_sessions')
    .update({ device_hash: deviceHash, claimed_at: ahora, verified_at: ahora })
    .eq('id', sessionId)
    .select('id')
  fail(error, 'No se pudo confirmar la sesión')
  return (data || []).length === 1
}

/**
 * El pedido de un cliente, con su línea de tiempo, para la pantalla de
 * seguimiento.
 *
 * ⚠️ Se filtra por NEGOCIO **y por TELÉFONO de la sesión**, no solo por el id
 * del pedido. Sin el teléfono, cualquiera con una sesión válida de esta tienda
 * podría leer el pedido de otro cliente —con su nombre y su dirección— probando
 * identificadores. Es la misma regla del resto de la tienda: el enlace
 * identifica a UNA persona, y solo ve lo suyo.
 *
 * Devuelve lo justo para pintar el seguimiento: ni la dirección completa ni el
 * comprobante, que no hacen falta para saber por dónde va.
 */
/**
 * Lo que ve el cliente de su propio pedido.
 *
 * `payment_confirmed_at` viaja porque quien transfirió necesita saber si su
 * plata llegó: sin él, el que mandó el comprobante por WhatsApp se queda
 * mirando los datos bancarios como si no hubiera pagado.
 *
 * Las líneas viajan para que el seguimiento diga QUÉ pidió — antes había que
 * volverse a WhatsApp para acordarse. Se nombran una a una en vez de
 * `order_items(*)`: de ahí solo se pintan seis campos, y los demás (ids
 * internos, precio unitario) no tienen por qué salir de la base.
 *
 * ⚠️ Va en una constante `as const` y NO partido con `+`. Concatenar lo
 * convierte en un `string` cualquiera y supabase-js deja de poder inferir la
 * forma de la respuesta: el `data` sale sin tipo y el spread de abajo no
 * compila. La alternativa era un cast, que es justo lo que se quitó de esta
 * capa.
 */
// ⚠️ `service_fee` viaja para enseñar la tarifa aparte, y el margen NO: lo que
// sale de aquí lo pasa la ruta por `pedidoParaElCliente`
// (`lib/precio-para-el-cliente.ts`), que convierte cada línea al precio que
// pagó el CLIENTE. `line_total` en la base es el precio del LOCAL.
const CAMPOS_DEL_SEGUIMIENTO = 'id,order_number,status,total,shipping,service_fee,currency,fulfillment,created_at,payment_confirmed_at,payment_method,order_items(product_name,variant_name,extras_names,item_note,quantity,line_total,order_item_options(option_group_name,option_name,quantity,group_sort))' as const

/**
 * Los pedidos de UN cliente en ESTE negocio, para su pestaña de Cuenta.
 *
 * Se filtra por `contact_phone` además de por negocio: es la misma llave con
 * la que se abre un pedido suelto, y la única que la sesión del enlace puede
 * demostrar. Sin ella, quien tuviera una sesión vería la bandeja del local.
 *
 * No trae la línea de tiempo —eso lo pide el seguimiento al abrir uno— pero sí
 * lo suficiente para pintar la lista: qué pidió, cuánto y cómo va.
 */
const getStorefrontOrders = async (input: {
  businessId: string
  contactPhone: string
  limit?: number
}) => {
  const { data, error } = await db
    .from('orders')
    .select(CAMPOS_DEL_SEGUIMIENTO)
    .eq('business_id', input.businessId)
    .eq('contact_phone', input.contactPhone)
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, input.limit || 20)))
  if (error) return { data: null, error }
  return { data: data || [], error: null }
}

/**
 * «Mis pedidos» de la APP: los de ESTE teléfono en TODOS los locales.
 *
 * ⚠️ El teléfono sale del token de la app —lo demostró WhatsApp al iniciar
 * sesión—, nunca de la petición. Se busca con sus variantes (`593…`,
 * `+593…`): el mismo número entra con y sin `+` según por dónde pidió.
 * Es la misma frontera que el pedido suelto de la tienda: el teléfono.
 */
const getAppOrders = async (telefono: string, limite = 30) => {
  const digitos = String(telefono || '').replace(/\D/g, '')
  if (!digitos) return { data: [], error: null }
  const { data, error } = await db
    .from('orders')
    .select(`business_id,contact_phone,${CAMPOS_DEL_SEGUIMIENTO},businesses(name,slug)`)
    .in('contact_phone', [digitos, `+${digitos}`])
    .order('created_at', { ascending: false })
    .limit(Math.min(50, Math.max(1, limite)))
  if (error) return { data: null, error }
  return { data: data || [], error: null }
}

/** De quién es un pedido, si es de este teléfono: para abrir su detalle. */
const getAppOrderOwner = async (telefono: string, orderId: string) => {
  const digitos = String(telefono || '').replace(/\D/g, '')
  if (!digitos) return null
  const { data, error } = await db
    .from('orders')
    .select('business_id,contact_phone,businesses(name,slug)')
    .eq('id', orderId)
    .in('contact_phone', [digitos, `+${digitos}`])
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as { business_id: string; contact_phone: string; businesses: { name: string; slug: string } | null } | null
}

const getStorefrontOrder = async (input: {
  businessId: string
  contactPhone: string
  orderId: string
}) => {
  const { data, error } = await db
    .from('orders')
    .select(CAMPOS_DEL_SEGUIMIENTO)
    .eq('business_id', input.businessId)
    .eq('contact_phone', input.contactPhone)
    .eq('id', input.orderId)
    .maybeSingle()
  if (error) return { data: null, error }
  if (!data) return { data: null, error: null }

  // El historial que ya se guardaba en cada cambio de estado. Sin él, «¿cuándo
  // se confirmó?» solo se responde mirando `updated_at`, que se pisa siempre.
  const eventos = await db
    .from('order_events')
    .select('to_status,created_at')
    .eq('business_id', input.businessId)
    .eq('order_id', input.orderId)
    // ⚠️ SIN los eventos de COCINA (2026-09-24). Desde la checklist de
    // preparación, `order_events` guarda también «producto_agregado» por cada
    // línea que el empleado mete en la bolsa. Eso es del local, no del
    // cliente: enseñárselo en su seguimiento le contaría cómo trabajan dentro
    // —y le pintaría una lista de estados que no entiende— en la pantalla
    // donde solo quiere saber si su pedido va en camino.
    .is('order_item_id', null)
    .order('created_at', { ascending: true })

  return { data: { ...data, events: eventos.data || [] }, error: null }
}


/**
 * Los métodos de pago que ese negocio acepta HOY.
 *
 * Devuelve solo los que el dueño tiene encendidos Y la plataforma sabe
 * procesar. La app pinta lo que reciba: dejó de tenerlos escritos a mano, que
 * es lo que hacía que un dueño creyera que elegía y no eligiera nada.
 */
const getStorefrontPaymentMethods = async (businessId: string) => {
  const { data, error } = await db.rpc('storefront_payment_methods', {
    p_business_id: businessId,
  })
  if (error) throw new Error(error.message)
  return (data || []) as Array<{
    code: string
    label: string
    help_text: string | null
    is_prepaid: boolean
    requires_proof: boolean
  }>
}

export = {
  registerPaymentReceipt,
  saveReceiptAnalysis,
  getReceiptAnalysis,
  getStorefrontPaymentMethods,
  resolveCustomer,
  claimStorefrontLinkSend,
  claimMiniappReply,
  isContactBlocked,
  contactBlockState,
  customerBlockState,
  claimBlockedNotice,
  getBusinessPricingRule,
  isCustomerBlocked,
  setContactBlocked,
  getBlockedContacts,
  bindStorefrontSession,
  getBusinessCustomer,
  setCustomerDisplayName,
  getCustomerAddresses,
  createCustomerAddress,
  setCustomerAddressLocation,
  deactivateCustomerAddress,
  createStorefrontSession,
  getStorefrontSessionByHash,
  claimStorefrontSession,
  touchStorefrontSession,
  cleanupStorefrontSessions,
  revokeOtherStorefrontSessions,
  revokeStorefrontSessionsExcept,
  revokeStorefrontSessionsOnExit,
  cancelUnpaidOrderOnPurpose,
  createStorefrontOrder,
  getOrderMoney,
  getStorefrontOrders,
  getStorefrontOrder,
  getAppOrders,
  getAppOrderOwner,
  attachStorefrontPaymentProof,
}
