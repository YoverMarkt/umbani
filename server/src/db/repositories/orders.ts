import type { SupabaseClient } from '@supabase/supabase-js'

type OrderData = Record<string, unknown>
type OrderItemData = Record<string, unknown>

const db: SupabaseClient = require('../client') as typeof import('../client')

const createOrder = async (order: OrderData, items: OrderItemData[]) => db.rpc(
  'create_order_with_items',
  {
    p_business_id: order.business_id,
    p_contact_phone: order.contact_phone,
    p_contact_name: order.contact_name,
    p_status: order.status || 'pendiente',
    p_discount: order.discount || 0,
    p_currency: order.currency || 'USD',
    p_items: items,
    // 'manual' = mostrador. Un pedido que nace 'completado' genera su venta
    // dentro de la misma función, así que aquí no hay un segundo paso.
    p_source: order.source || 'whatsapp',
  },
)

// El filtro por estado lo usa la vigilancia del panel: pedir solo lo que
// espera al negocio evita traer 100 pedidos con sus ítems cada pocos segundos.
// La ruta valida los estados; aquí solo se aplican si vienen.
//
// ⚠️ Admite VARIOS a propósito. Con uno solo se quedó corto el 2026-08-08: la
// alarma vigilaba «pendiente» y, desde que quien transfiere nace en
// `esperando_pago`, ningún pedido con comprobante volvía a sonar. Lo que pide
// atención son dos estados distintos, no uno.
const getOrders = async (
  businessId: string,
  limit = 100,
  status: string | string[] | null = null,
) => {
  // La dirección sale de las columnas `delivery_*` del propio pedido, que las
  // trae el `*`. Antes se incrustaba `customer_addresses` por `address_id` y
  // eso no decía a dónde iba el pedido: decía a dónde va HOY esa dirección.
  let query = db
    .from('orders')
    .select('*, order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))')
    .eq('business_id', businessId)
  if (Array.isArray(status)) {
    if (status.length) query = query.in('status', status)
  } else if (status) {
    query = query.eq('status', status)
  }
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data || []) as OrderData[]
}

/**
 * Las formas en que el MISMO teléfono aparece guardado.
 *
 * ⚠️ Un pedido hecho por la mini app guarda `593990978367` —su CHECK exige
 * solo dígitos— y el mismo cliente escribiendo por WhatsApp llega como
 * `+593990978367`. Buscar con `=` no encuentra nada, y no falla: devuelve
 * vacío, que es peor porque parece que ese cliente nunca pidió.
 *
 * Costó un rato descubrirlo el 2026-08-12: el comprobante que llegaba por el
 * chat no se adjuntaba a ningún pedido y el bot respondía con el enlace del
 * menú a quien acababa de pagar. No había ningún error que mirar.
 */
const variantesDelTelefono = (telefono: string): string[] => {
  const crudo = String(telefono || '').trim()
  const digitos = crudo.replace(/\D/g, '')
  if (!digitos) return crudo ? [crudo] : []
  return [...new Set([crudo, digitos, `+${digitos}`])]
}

// Último pedido de UN contacto dentro de SU negocio. Alimenta «repetir pedido»
// del modo menú y el comprobante que llega por el chat: se leen los ítems para
// rearmar el carrito, pero los precios NO se reutilizan — los recalcula el
// catálogo vigente.
const getLastOrderForContact = async (businessId: string, contactPhone: string) => {
  const { data, error } = await db
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', businessId)
    // Con `in` en vez de `eq`: el mismo número vive con y sin el `+` según por
    // dónde entró el pedido.
    .in('contact_phone', variantesDelTelefono(contactPhone))
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as OrderData | null
}

/**
 * Los pedidos de UN CLIENTE que esperan comprobante, en cualquier local.
 *
 * ⚠️ Existe porque `getLastOrderForContact` decide el local por el NÚMERO al
 * que llegó el mensaje, y en el marketplace todos los clientes escriben al
 * mismo. Ahí el número no dice nada: el local sale del PEDIDO, nunca al revés.
 * Sin esto, el comprobante de una pizzería podía adjuntarse al pedido abierto
 * de una cevichería — dinero atribuido al local equivocado, y el cliente que
 * sí pagó esperando.
 *
 * `businessId` es un filtro OPCIONAL: cuando el negocio tiene número propio, el
 * canal SÍ desambigua y conviene usarlo. Cuando no lo tiene, se busca en todos
 * y quien llama decide qué hacer si hay más de uno.
 */
const pedidosEsperandoComprobante = async (
  contactPhone: string,
  businessId?: string | null,
) => {
  let consulta = db
    .from('orders')
    // ⚠️ `customer_id` viaja desde el 2026-09-01: es a quien se le cuenta el
    // rechazo cuando la imagen no era un comprobante, y el local sale de aquí
    // —del PEDIDO— nunca del número por el que llegó la foto.
    // ⚠️ `contact_name` viaja desde el 2026-09-01: es con lo que se compara
    // el ORDENANTE del comprobante. No rechaza —pagar desde la cuenta de
    // la pareja es normal— pero el dueño tiene que verlo.
    .select('id, business_id, customer_id, order_number, total, contact_phone, contact_name, created_at, businesses(name)')
    .eq('status', 'esperando_pago')
    .is('payment_proof_url', null)
    .is('payment_confirmed_at', null)
    // ⚠️ Con TARJETA no hay comprobante (2026-09-27): una foto no puede
    // colgarse de un pedido que se paga en PayPhone. `payment_method` es nulo
    // en los pedidos del bot, y esos SÍ se quedan.
    .or('payment_method.is.null,payment_method.neq.tarjeta')
    // El mismo número vive con y sin el `+` según por dónde entró el pedido.
    .in('contact_phone', variantesDelTelefono(contactPhone))
    .order('created_at', { ascending: false })
    .limit(10)
  if (businessId) consulta = consulta.eq('business_id', businessId)

  const { data, error } = await consulta
  if (error) throw new Error(error.message)
  return (data || []) as Array<{
    id: string
    business_id: string
    order_number: number | null
    total: number | null
    contact_phone: string | null
    /** Con quién se pidió: se compara contra el ordenante del comprobante. */
    contact_name: string | null
    // Ya venía en el `select` pero no estaba declarado, así que el análisis no
    // lo veía: es con lo que se detecta un comprobante viejo reciclado.
    created_at: string | null
    businesses?: { name?: string | null } | null
  }>
}

const updateOrder = async (
  businessId: string,
  id: string,
  data: OrderData,
) => {
  const safe = { ...data }
  delete safe.id
  delete safe.business_id
  delete safe.created_at
  return db
    .from('orders')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', id)
}

/**
 * Devuelve el pedido a «esperando pago» y BORRA el comprobante anterior.
 *
 * Las dos cosas van juntas: sin borrarlo, el buzón de WhatsApp rechazaría la
 * foto siguiente —solo adjunta cuando no hay una ya puesta— y el dueño se
 * quedaría mirando la borrosa para siempre.
 */
const requestNewPaymentProof = async (businessId: string, orderId: string) => {
  const { data, error } = await db.rpc('request_new_payment_proof', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  return { data, error }
}

const setOrderStatus = async (businessId: string, id: string, status: string) => db.rpc(
  'set_order_status',
  {
    p_business_id: businessId,
    p_order_id: id,
    p_status: status,
  },
)

/**
 * Reclama el derecho a avisarle al cliente DE ESTE HITO, y devuelve el pedido
 * si lo gana.
 *
 * ⚠️ RECLAMA, no consulta. El `where` va dentro del propio `update`, que es
 * atómico: si dos peticiones llegan a la vez, una sola se lleva la fila y la
 * otra recibe `null`. Comprobar primero y enviar después dejaría una carrera
 * entre las dos operaciones — las dos leerían lo mismo y las dos mandarían el
 * mensaje.
 *
 * Hace falta porque `set_order_status` devuelve `updated` también cuando el
 * estado ya era ese, así que desde fuera un segundo toque en un botón es
 * indistinguible del primero. Y desde el 1 de octubre de 2026 Meta cobra cada
 * mensaje de servicio: el doble toque se paga dos veces.
 *
 * ⚠️ Se compara con el ÚLTIMO estado avisado, no con una lista de todos. Vale
 * porque el pedido nunca retrocede —`set_order_status` lo prohíbe—, así que
 * los hitos llegan siempre en fila y cada uno es distinto del anterior.
 *
 * El `or` cubre el nulo a mano: `neq` en PostgreSQL descarta las filas nulas,
 * así que un pedido del que no se ha avisado nada no pasaría el filtro y
 * jamás recibiría su primer mensaje.
 */
/**
 * Expira los pedidos que llevan demasiado esperando su comprobante.
 *
 * Devuelve los que expiró para que el llamador mande los avisos: la base no
 * habla WhatsApp, y hacerlo dentro de la transacción la dejaría abierta
 * mientras se espera a un proveedor externo.
 *
 * ⚠️ El tope por tanda es el freno principal contra el escenario que temía la
 * nota de `order-notify.ts` —cien avisos de golpe—, junto con la ventana de
 * 24 h que la propia función aplica.
 */
const expireUnpaidOrders = async (
  limite = 20,
): Promise<{ order_id: string; business_id: string; order_number: number | null }[]> => {
  const { data, error } = await db.rpc('expire_unpaid_orders', { p_limite: limite })
  if (error) throw new Error(error.message)
  return (data || []) as { order_id: string; business_id: string; order_number: number | null }[]
}

/**
 * Anota que este cliente dejó caducar un pedido sin pagar, y lo bloquea al
 * tercero.
 *
 * ⚠️ Se cuenta por CLIENTE y NEGOCIO. Quien abandona en una pizzería puede ser
 * impecable en la heladería de al lado, y bloquearlo en toda la plataforma por
 * lo que hizo en un local sería un castigo que no puede ni entender ni
 * resolver.
 *
 * Devuelve cuántas van y si esta fue la última, para que el aviso diga la
 * verdad en vez de un genérico. El cliente del pedido lo resuelve la propia
 * función: así no hay forma de sumarle una falta a un tercero.
 */
const registerUnpaidExpiry = async (
  businessId: string,
  orderId: string,
): Promise<{ strikes: number; blocked: boolean; limit: number }> => {
  const { data, error } = await db.rpc('register_unpaid_expiry', {
    p_business_id: businessId,
    p_order_id: orderId,
  })
  // Que no se pueda contar la falta NO puede impedir el aviso: el pedido ya
  // caducó y el cliente tiene que enterarse igual.
  if (error || !data) return { strikes: 0, blocked: false, limit: 3 }
  return data as { strikes: number; blocked: boolean; limit: number }
}

/**
 * Anota que este cliente mandó una imagen que NO era un comprobante, y lo
 * bloquea un rato al segundo seguido.
 *
 * La compuerta ya rechazaba la foto y le pedía la captura buena. Lo que
 * faltaba es que INSISTIR tuviera consecuencia: quien manda dos seguidas está
 * probando, no equivocándose.
 *
 * ⚠️ El bloqueo que pone es TEMPORAL, y eso importa más aquí que en los
 * pedidos sin pagar: la visión se equivoca. Una captura movida, un banco con
 * un diseño raro, una transferencia hecha desde la cuenta de un familiar. Con
 * media hora fuera, el cliente honesto vuelve esa misma noche; con un bloqueo
 * permanente se habría perdido la venta y el cliente.
 */
const registerRejectedReceipt = async (
  businessId: string,
  customerId: string,
): Promise<{ strikes: number; blocked: boolean; limit: number; minutes?: number | null }> => {
  const { data, error } = await db.rpc('register_rejected_receipt', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  // Que no se pueda contar NO puede impedir la respuesta al cliente: sigue
  // necesitando saber que su foto no servía.
  if (error || !data) return { strikes: 0, blocked: false, limit: 2 }
  return data as { strikes: number; blocked: boolean; limit: number; minutes?: number | null }
}

/**
 * Pone a cero los rechazos: llegó un comprobante bueno.
 *
 * Cuenta la INSISTENCIA, no el historial. Quien mandó una borrosa, luego la
 * buena, y dentro de tres semanas otra borrosa, no es el que está probando a
 * ver si cuela algo — y sin esto acabaría bloqueado por dos despistes
 * separados por meses.
 */
const clearRejectedReceipts = async (businessId: string, customerId: string): Promise<void> => {
  await db.rpc('clear_rejected_receipts', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
}

const claimOrderNotification = async (
  businessId: string,
  orderId: string,
  status: string,
) => {
  const { data, error } = await db
    .from('orders')
    .update({
      customer_notified_status: status,
      customer_notified_at: new Date().toISOString(),
    })
    .eq('business_id', businessId)
    .eq('id', orderId)
    .or(`customer_notified_status.is.null,customer_notified_status.neq.${status}`)
    // Las opciones viajan con cada línea: el aviso de preparación cuenta lo
    // que el cliente eligió, y sin ellas decía «1× Pizza» y punto.
    // ⚠️ El método y la marca de pago: con tarjeta el aviso de caducidad y el
    // de cancelación cuentan otra cosa. Mismas columnas que `getOrderForNotice`
    // (la cola): los dos caminos tienen que redactar el MISMO mensaje.
    .select(
      'id,order_number,status,fulfillment,contact_phone,contact_name,total,currency,'
      + 'payment_method,payment_confirmed_at,'
      + 'order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))',
    )
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as OrderData | null
}

/**
 * El pedido con lo justo para avisar a su DUEÑO por WhatsApp.
 *
 * ⚠️ Filtra por `business_id`, como toda consulta de este repositorio. El id
 * del pedido llega del flujo que acaba de crearlo, pero una función capaz de
 * leer un pedido sin decir de qué local es acaba leyendo el de otro el día que
 * alguien le pase un id ajeno.
 *
 * ⚠️ Trae el punto de ENTREGA del cliente (`delivery_*`), que es lo que hace
 * útil el aviso: el dueño necesita saber a dónde va —y mañana, el repartidor—.
 * Sin eso el mensaje sería un resumen de lo que ya está en el panel.
 */
const getOrderForOwnerNotice = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .select(
      'id,order_number,fulfillment,payment_method,contact_name,contact_phone,total,'
      + 'delivery_address,delivery_reference,delivery_latitude,delivery_longitude,'
      + 'delivery_courier_notes,'
      + 'order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))',
    )
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as Record<string, unknown> | null
}

/**
 * Marca que el negocio dio el pago por bueno.
 *
 * Existe para el pago que llegó POR FUERA de la app: la mayoría transfiere
 * desde su banco y manda la captura por WhatsApp, a veces desde la cuenta de
 * otra persona. Ese pago es tan válido como el que se sube aquí, pero antes no
 * había dónde anotarlo — el cliente seguía viendo el número de cuenta y el
 * dueño, «sin comprobante todavía».
 *
 * ⚠️ Las condiciones van en el `where`, no en un `if` de la ruta. Es una sola
 * operación atómica y no hay forma de colarse por otro camino:
 *
 *  · **el negocio**, siempre, o se estaría marcando el pedido de otro local;
 *  · **transferencia**, porque en efectivo y «pago al retirar» se cobra al
 *    entregar: marcarlo antes diría que hay un dinero que nadie ha recibido;
 *  · **estado no final** — dar por pagado un pedido cancelado o expirado no
 *    significa nada, y en el reporte parecería dinero cobrado;
 *  · **`payment_confirmed_at is null`**, para que dos toques seguidos no
 *    muevan la hora y el cliente vea saltar el momento en que le confirmaron.
 *
 * Devuelve el pedido si lo marcó, y `null` si no cumplía. Quien llama
 * distingue los dos casos, que no son el mismo error.
 */
/**
 * Marca una línea del pedido como metida en la bolsa.
 *
 * ⚠️ La decide PostgreSQL, no esta capa: `marcar_linea_preparada` comprueba
 * que el pedido y la línea sean de ESTE negocio y lanza 42501 si no. Ponerlo
 * aquí sería una promesa del servidor; ahí es una regla de la base.
 *
 * ⚠️ Idempotente: en una cocina se toca dos veces por nervio. Un doble toque
 * no deja dos eventos ni cambia quién la marcó.
 */
const markOrderItemPrepared = async (
  businessId: string,
  orderId: string,
  itemId: string,
  userId: string | null,
) => {
  const { data, error } = await db.rpc('marcar_linea_preparada', {
    p_business_id: businessId,
    p_order_id: orderId,
    p_item_id: itemId,
    p_user_id: userId,
  })
  if (error) throw new Error(error.message)
  return data as { result: string; faltan?: number; total?: number; status?: string }
}

const confirmOrderPayment = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .update({ payment_confirmed_at: new Date().toISOString() })
    .eq('business_id', businessId)
    .eq('id', orderId)
    .eq('payment_method', 'transferencia')
    .is('payment_confirmed_at', null)
    .not('status', 'in', '("completado","cancelado","rechazado","expirado")')
    .select('id,status,payment_confirmed_at')
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as { id: string; status: string; payment_confirmed_at: string } | null
}

/**
 * Lo justo para abrir un comprobante: su URL y su identificador de Cloudinary.
 *
 * Se pide por negocio Y por pedido, nunca solo por pedido: el id viaja en la
 * dirección y sin el negocio se estaría dando el comprobante de otro local.
 */
/**
 * Lo mínimo del pedido para CUADRAR su comprobante: cuánto, de cuándo y de quién.
 *
 * ⚠️ Son exactamente los tres campos que `cuadreDelComprobante` compara con lo
 * que la visión leyó de la imagen — el monto para «¿pagó de menos?», la fecha
 * para «¿es de antes del pedido?» y el nombre para el panel. Ni uno más: esto
 * corre por un camino público (la tienda), y traer la fila entera sería pasear
 * datos que ese camino no necesita.
 */
const getOrderForReceiptCheck = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .select('total,created_at,contact_name')
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data || null) as {
    total?: unknown
    created_at?: string | null
    contact_name?: string | null
  } | null
}

const getOrderProof = async (businessId: string, orderId: string) => {
  const { data } = await db
    .from('orders')
    .select('payment_proof_url,payment_proof_public_id')
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  return (data || null) as unknown as {
    payment_proof_url?: string | null
    payment_proof_public_id?: string | null
  } | null
}

export = {
  getOrderForReceiptCheck,
  getOrderProof,
  createOrder,
  getOrders,
  getLastOrderForContact,
  variantesDelTelefono,
  updateOrder,
  setOrderStatus,
  requestNewPaymentProof,
  confirmOrderPayment,
  markOrderItemPrepared,
  claimOrderNotification,
  expireUnpaidOrders,
  registerUnpaidExpiry,
  registerRejectedReceipt,
  clearRejectedReceipts,
  pedidosEsperandoComprobante,
  getOrderForOwnerNotice,
}
