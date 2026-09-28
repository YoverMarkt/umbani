// ── API de Pedidos ───────────────────────────────────────────────────────
// Un pedido LLEGA y hay que atenderlo; una venta se registra cuando ya se
// cobró. Por eso viven en secciones distintas, y este archivo es el de los
// pedidos: la bandeja de entrada del negocio.
//
// Ningún importe se calcula aquí. Subtotal, envío y total los trae el servidor
// tal como los guardó PostgreSQL (regla inviolable #8).
import { api } from '../../api/client'

export type OrderStatus =
  | 'pendiente' | 'esperando_pago' | 'pago_en_revision' | 'confirmado'
  | 'aceptado' | 'preparacion' | 'listo_para_retiro' | 'en_camino'
  | 'completado' | 'cancelado' | 'rechazado' | 'expirado'

/**
 * Estados en los que el pedido todavía pide algo del negocio.
 *
 * `pago_en_revision` entra porque es lo que MÁS pide: hay un comprobante
 * esperando a que alguien lo mire, y mientras tanto el cliente no sabe si su
 * pedido existe.
 */
export const ACTIVOS: OrderStatus[] = [
  'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado',
  'aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
]

/**
 * Lo que el cliente eligió, agrupado por el SERVIDOR (`order-detail.ts`).
 *
 * Llega agrupado y no en crudo a propósito: el mismo plato se enseña aquí, en
 * el seguimiento de la mini app y en el WhatsApp del cliente. Agrupar en cada
 * sitio es como acabaron diciendo cosas distintas del mismo pedido.
 */
export type GrupoElegido = {
  group: string
  items: { name: string; quantity: number }[]
}

export type OrderItem = {
  /**
   * El id de la LÍNEA, no del producto.
   *
   * ⚠️ Hacía falta declararlo para la checklist: es lo que se manda al marcar
   * que ya está en la bolsa. El servidor siempre lo mandó (`select('*')`),
   * solo que nadie lo usaba y la lista se pintaba por índice.
   */
  id: string
  product_id: string | null
  product_name: string
  variant_name?: string | null
  /** Ya agrupado. Vacío en los pedidos anteriores al motor de opciones. */
  options?: GrupoElegido[] | null
  /** El respaldo de esos pedidos viejos: una lista plana, sin grupos. */
  extras_names?: string[] | null
  item_note?: string | null
  quantity: number
  unit_price: number | string
  line_total: number | string
  /**
   * Cuándo se metió esta línea en la bolsa. Nula = todavía pendiente.
   *
   * ⚠️ Es una FECHA y no un estado porque «agregado» y «confirmado» son el
   * mismo instante: el empleado la mete y la tilda.
   */
  prepared_at?: string | null
}

export type Order = {
  id: string
  contact_phone: string
  contact_name: string | null
  status: OrderStatus
  source?: string | null
  fulfillment?: 'delivery' | 'pickup' | 'onsite' | null
  subtotal: number | string
  discount: number | string
  shipping?: number | string | null
  total: number | string
  /**
   * Lo que se queda la plataforma, sellado por `orders_stamp_pricing`.
   *
   * ⚠️ Ya venía en la respuesta desde siempre —el repositorio pide `select('*')`—
   * pero no estaba declarado aquí ni se pintaba, y con el margen `on_top` eso
   * dejaba la tarjeta SIN CUADRAR a la vista: subtotal $10.99 + envío $2.00 no
   * suman los $14.09 del total, y el $1.10 que falta no aparecía por ningún
   * lado. El dueño leía una resta imposible en la pantalla que mira a diario.
   *
   * Nulo o 0 en los pedidos sin regla de margen, que es la mayoría de los
   * viejos: entonces la tarjeta se pinta como siempre.
   */
  platform_markup?: number | string | null
  /** Lo que le queda al comercio por los productos, sin envío. */
  merchant_subtotal?: number | string | null
  currency?: string
  payment_method?: 'transferencia' | 'efectivo' | 'pago_al_retirar' | 'tarjeta' | null
  /** Lo que el cliente escribió para ESTE pedido: «llame al llegar». */
  delivery_notes?: string | null
  payment_proof_url?: string | null
  /** Cuándo el negocio dio el pago por bueno. Nulo = todavía no. */
  payment_confirmed_at?: string | null
  /** Para cuándo lo quiere el cliente. Nulo = lo antes posible. */
  scheduled_for?: string | null
  created_at: string
  order_items: OrderItem[]
  /**
   * A dónde va ESTE pedido, congelado al crearlo.
   *
   * Antes se leía incrustando `customer_addresses` por `address_id`, o sea que
   * el pedido preguntaba a dónde va HOY esa dirección: si el cliente la
   * corregía a media entrega, la pantalla cambiaba debajo del repartidor, y si
   * la borraba el pedido se quedaba sin destino. Ahora es una fotografía, como
   * `product_name` en cada línea.
   */
  delivery_label?: string | null
  delivery_address?: string | null
  delivery_reference?: string | null
  delivery_latitude?: number | string | null
  delivery_longitude?: number | string | null
  /** Metros de error del GPS. Un pin con 2 km de error es un pin que miente. */
  delivery_accuracy_m?: number | string | null
  delivery_building_type?: string | null
  /** Lo permanente de esa casa: «el timbre no sirve». No es `delivery_notes`. */
  delivery_courier_notes?: string | null
}

export const getOrders = () => api<Order[]>('/api/client/orders')

/** Catálogo para el pedido de mostrador. Los precios son informativos: el
 *  importe oficial lo resuelve la base con los ids que se le manden. */
export const getProducts = () =>
  api<{ id: string; name: string; price: string | number; price_sale: string | number | null }[]>(
    '/api/client/products',
  )

/**
 * Pedido de mostrador: nace entregado y la base le crea su venta.
 * Se mandan ids y cantidades; ningún precio viaja desde el navegador.
 */
export const createCounterOrder = (input: {
  contact_phone?: string | null
  contact_name?: string | null
  items: { product_id: string; quantity: number }[]
}) => api<{ id: string; total: number | string }>('/api/client/orders', {
  method: 'POST',
  body: JSON.stringify(input),
})

/**
 * El comprobante ya no vive en una URL pública: es un movimiento bancario de
 * un cliente real. El servidor firma un acceso temporal —diez minutos— cada
 * vez que el dueño quiere verlo, así que se pide justo al tocar el enlace y
 * nunca se guarda en la pantalla.
 */
export const getOrderProof = (id: string) =>
  api<{ url: string; firmada: boolean }>(`/api/client/orders/${id}/proof`)

/** Una señal del análisis, con los puntos que aportó al score. */
export type SenalDeRiesgo = {
  flag_type: string
  severity: 'baja' | 'media' | 'alta' | 'critica'
  description?: string | null
  points: number
}

/**
 * Lo que el sistema leyó del comprobante.
 *
 * ⚠️ NADA de esto confirma que el dinero haya entrado. El panel lo dice encima
 * de los datos, siempre y sin excepción: un comprobante que se lee perfecto
 * sigue siendo una imagen, y pudo editarse, generarse o reutilizarse.
 */
export type ReceiptAnalysis = {
  receipt_id: string
  status: 'pendiente_analisis' | 'analizado' | 'requiere_revision' | 'descartado'
  bank_name?: string | null
  sender_name?: string | null
  beneficiary_name?: string | null
  destination_account?: string | null
  amount?: string | number | null
  currency?: string | null
  transaction_date?: string | null
  transaction_time?: string | null
  reference_number?: string | null
  transaction_number?: string | null
  risk_score?: number | null
  risk_level?: 'bajo' | 'medio' | 'alto' | 'critico' | null
  flags: SenalDeRiesgo[]
}

export const getReceiptAnalysis = (id: string) =>
  api<{
    analisis: ReceiptAnalysis | null
    esperado: {
      bank_name?: string | null
      account_number?: string | null
      holder_name?: string | null
    } | null
  }>(`/api/client/orders/${id}/receipt-analysis`)

export const setOrderStatus = (id: string, status: OrderStatus) =>
  api(`/api/client/orders/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  })

/**
 * «Ya me llegó el pago», sin arrancar el pedido.
 *
 * Para la transferencia que no pasó por la app: el cliente pagó desde su banco
 * —o desde la cuenta de un familiar— y mandó la captura por WhatsApp. Aceptar
 * el pedido también lo marca; esto existe para el rato en que el dueño da el
 * pago por bueno pero todavía no va a preparar nada.
 */
export const confirmOrderPayment = (id: string) =>
  api<{ id: string; status: OrderStatus; payment_confirmed_at: string }>(
    `/api/client/orders/${id}/payment-confirmed`,
    { method: 'PUT' },
  )

/**
 * Le pide otro comprobante al cliente sin cerrar el pedido.
 *
 * ⚠️ Existe porque rechazar CIERRA: `rechazado` es un estado final y al
 * cliente le llega «tu pedido fue cancelado». Una foto borrosa costaba una
 * venta entera.
 *
 * Devuelve el pedido a «esperando pago» y borra el comprobante anterior — sin
 * eso, el buzón de WhatsApp rechazaría la foto siguiente porque solo adjunta
 * cuando no hay una ya puesta.
 */
export const requestNewProof = (id: string) =>
  api<{ ok: true }>(`/api/client/orders/${id}/request-proof`, { method: 'POST' })

export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`

export const ESTADO_TEXTO: Record<OrderStatus, string> = {
  pendiente: 'Nuevo',
  esperando_pago: 'Esperando pago',
  pago_en_revision: 'Comprobante por revisar',
  confirmado: 'Confirmado',
  aceptado: 'Aceptado',
  preparacion: 'En preparación',
  listo_para_retiro: 'Listo para retirar',
  en_camino: 'En camino',
  completado: 'Entregado',
  cancelado: 'Cancelado',
  rechazado: 'Rechazado',
  expirado: 'Expirado',
}

export const ESTADO_COLOR: Record<OrderStatus, string> = {
  pendiente: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  // El comprobante por revisar va en rojo a propósito: es lo único que frena
  // un pedido esperando a que una persona lo mire.
  esperando_pago: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  pago_en_revision: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  confirmado: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  aceptado: 'bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300',
  preparacion: 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300',
  listo_para_retiro: 'bg-teal-100 text-teal-800 dark:bg-teal-500/15 dark:text-teal-300',
  en_camino: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  completado: 'bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300',
  cancelado: 'bg-muted text-muted-foreground',
  rechazado: 'bg-muted text-muted-foreground',
  expirado: 'bg-muted text-muted-foreground',
}

/**
 * El paso natural hacia adelante. Va SIEMPRE en el mismo sentido: la RPC
 * `set_order_status` rechaza cualquier retroceso, así que aquí ni se ofrece.
 *
 * «En camino» solo existe para lo que sale a la calle: un pedido que el
 * cliente retira en el local lo bloquea la base, y enseñar un botón que va a
 * fallar es peor que no enseñarlo.
 */
export const siguientePaso = (pedido: Order): {
  status: OrderStatus
  etiqueta: string
  descripcion: string
  /** El paso avanza sin que nadie haya comprobado el pago: el botón lo dice. */
  avisa?: boolean
} | null => {
  const reparte = !pedido.fulfillment || pedido.fulfillment === 'delivery'

  // ── Con TARJETA, sin cobro no hay paso adelante ─────────────────────────
  //
  // Al revés que la transferencia: aquí no hay pago «por otra vía» que el
  // dueño pueda haber visto. El dinero solo existe si PayPhone lo confirmó, y
  // la base rechaza avanzar sin eso (`orders_card_requires_payment`). Un botón
  // que va a fallar es peor que ningún botón: el pedido espera, o se cancela.
  if (pedido.payment_method === 'tarjeta' && !pedido.payment_confirmed_at) return null

  // ── Aceptar y preparar es UN paso ────────────────────────────────────────
  //
  // Eran dos: aceptar el pedido y después ponerlo en preparación. Para una
  // cocina son la misma decisión —quien acepta es quien manda hacerlo—, y el
  // paso intermedio dejaba al cliente mirando un «aceptado» que no le dice
  // nada. Un toque menos por pedido, y el cliente ve «en preparación» en
  // cuanto el dueño se ocupa de él.
  //
  // Rechazar sigue siendo la otra salida, por su propio botón.
  if (pedido.status === 'pendiente' || pedido.status === 'esperando_pago') {
    // ── Aceptar sin tener el comprobante en la app ─────────────────────────
    //
    // NO se bloquea el botón, y es deliberado: en Ecuador la mayoría
    // transfiere desde su banco y manda la captura por WhatsApp. Un dueño con
    // el dinero ya en su cuenta y la foto en el chat no puede quedarse
    // mirando un botón gris. Lo que sí hace falta es que el botón no mienta:
    // decir «Aceptar y preparar» a secas, igual que cuando el comprobante
    // está subido, esconde que aquí nadie ha comprobado nada.
    const sinComprobante = pedido.status === 'esperando_pago'
      && !pedido.payment_proof_url
      && !pedido.payment_confirmed_at
    if (sinComprobante) return {
      status: 'preparacion',
      etiqueta: 'Recibí el pago, preparar',
      descripcion: 'Este pedido no tiene comprobante subido. Confírmalo solo si '
        + 'ya te llegó la transferencia por otra vía.',
      avisa: true,
    }
    return {
      status: 'preparacion',
      etiqueta: 'Aceptar y preparar',
      descripcion: 'El cliente lo ve en preparación al instante.',
    }
  }
  // Con el comprobante en revisión, aceptarlo es dar el pago por bueno Y
  // arrancar. Es lo que de verdad hace el dueño cuando mira la transferencia.
  if (pedido.status === 'pago_en_revision') return {
    status: 'preparacion',
    etiqueta: 'Aceptar el pago y preparar',
    descripcion: 'El comprobante cuadra: entra en la cocina.',
  }
  // Los pedidos que ya venían aceptados de antes siguen su camino. No se
  // crean nuevos en estos estados, pero los que existan tienen que poder
  // avanzar: nadie se queda encallado por un cambio de flujo.
  if (pedido.status === 'confirmado' || pedido.status === 'aceptado') return {
    status: 'preparacion',
    etiqueta: 'Poner en preparación',
    descripcion: 'Se marca como que ya se está preparando.',
  }
  if (pedido.status === 'preparacion' && reparte) return {
    status: 'en_camino',
    etiqueta: 'Marcar en camino',
    descripcion: 'El pedido sale a entregarse.',
  }
  // Quien retira en el local no pasa por «en camino»: pasa por «listo». Sin
  // este paso, el cliente no sabe cuándo ir a buscarlo.
  if (pedido.status === 'preparacion' && !reparte) return {
    status: 'listo_para_retiro',
    etiqueta: 'Marcar listo para retirar',
    descripcion: 'Avísale al cliente que ya puede venir a recogerlo.',
  }
  if (pedido.status === 'listo_para_retiro') return {
    status: 'completado',
    etiqueta: 'Marcar entregado',
    descripcion: 'El cliente ya lo retiró.',
  }
  if (pedido.status === 'en_camino') return {
    status: 'completado',
    etiqueta: 'Marcar entregado',
    descripcion: 'El pedido queda cerrado como entregado.',
  }
  return null
}

/**
 * Marca una línea como metida en la bolsa.
 *
 * ⚠️ Quien decide es PostgreSQL: comprueba que la línea sea de este negocio y
 * es idempotente, porque en una cocina se toca dos veces por nervio.
 */
export const marcarLineaPreparada = (orderId: string, itemId: string) =>
  api<{ result: string; faltan: number; total: number }>(
    `/api/client/orders/${orderId}/items/${itemId}/prepared`,
    { method: 'POST' },
  )
