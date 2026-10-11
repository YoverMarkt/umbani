// ═══════════════════════════════════════════════════════════════════════════
// EL DESGLOSE QUE LE FALTABA A LA TARJETA DEL PEDIDO
// ═══════════════════════════════════════════════════════════════════════════
//
// Caso REAL, visto por el dueño en la pantalla de Pedidos el 2026-09-20:
//
//     1× Burger Pack                                              $10.99
//     Subtotal $10.99   Envío $2.00   Total $14.09
//
// $10.99 + $2.00 son $12.99, no $14.09. **Faltaban $1.10 sin explicar** en la
// pantalla que el dueño mira a diario para cotejar comprobantes. No era un
// error de cálculo —el dinero estaba bien repartido— sino que el margen de la
// plataforma no se pintaba en ninguna parte.
//
// El importe YA venía en la respuesta desde siempre: el repositorio pide
// `select('*')` y `orders.platform_markup` viaja con el resto. Solo no estaba
// declarado en el tipo ni dibujado.
//
// ── DOS REGLAS QUE NO SE NEGOCIAN ──────────────────────────────────────────
//
// 1. **El TOTAL sigue siendo el del CLIENTE.** Es lo que se transfiere y
//    contra lo que se compara el comprobante: cambiarlo por lo que recibe el
//    local rompería la validación de comprobantes. Lo que se añade es de dónde
//    sale el margen y cuánto queda, nunca en lugar del total.
//
// 2. **Esto es del panel del DUEÑO.** Al cliente no se le enseña el desglose:
//    paga su total con el margen ya dentro del precio (decisión del dueño,
//    2026-09-20).

/** Lo que hace falta del pedido para repartir su dinero. */
export interface DineroDelPedido {
  subtotal?: number | string | null
  /** La carrera. Va aparte porque NO es del local. */
  shipping?: number | string | null
  total?: number | string | null
  platform_markup?: number | string | null
  merchant_subtotal?: number | string | null
  status?: string | null
}

/**
 * Los estados en los que el pedido MURIÓ sin que se moviera un centavo.
 *
 * ⚠️ Esto es lo que hace que la tarjeta CUADRE CON FINANZAS, y no es un detalle
 * de redacción. `platform_markup_summary` —lo que alimenta la comisión del mes
 * y la tarjeta de Finanzas— suma solo ventas `completada`, y una venta nace al
 * ENTREGAR. Un pedido expirado, cancelado o rechazado nunca llega a `sales`:
 * la plataforma NO le factura ese servicio y el local NO recibe nada.
 *
 * Sin esta distinción la tarjeta afirmaba «Servicio $1.20 · Recibes $13.98»
 * sobre un pedido EXPIRADO —el caso que lo destapó, 2026-09-20— y sumar los
 * servicios que se ven en pantalla nunca daba el número de Finanzas.
 */
const SIN_COBRO = ['cancelado', 'rechazado', 'expirado']

/**
 * Si este pedido mueve dinero de verdad.
 *
 * Los que siguen vivos todavía no están en Finanzas pero llegarán si se
 * entregan; los muertos no llegarán nunca.
 */
export const elPedidoSeCobra = (status?: string | null): boolean =>
  !SIN_COBRO.includes(String(status || '').trim())

export interface DesgloseDelPedido {
  /** Lo que se queda la plataforma. 0 = no hay nada que enseñar. */
  servicio: number
  /**
   * Lo que recibe el local POR SUS PRODUCTOS. Sin la carrera.
   *
   * ⚠️ Este es el número del dueño, y el que va a los reportes.
   */
  porLosProductos: number
  /**
   * La carrera. NO es del local: es de quien reparte.
   *
   * Hoy reparte el propio local, así que hoy también acaba en su bolsillo —
   * pero no por vender comida, sino por llevarla. Van separadas desde ya para
   * que el día que exista el módulo de repartidores no haya que volver a
   * explicarle al dueño por qué le baja un número.
   */
  reparto: number
  /**
   * Si el servicio se SUMÓ al cliente (`on_top`) o se le DESCONTÓ al comercio
   * (`absorbed`). Decide el signo con que se pinta: con `absorbed` ya está
   * DENTRO del subtotal, así que enseñarlo sumando dejaría la cuenta cuadrando
   * al revés.
   */
  servicioVaEncima: boolean
}

const numero = (valor: unknown): number => {
  const n = Number(valor ?? 0)
  return Number.isFinite(n) ? n : 0
}

const aCentavos = (valor: number): number => Math.round(valor * 100) / 100

/**
 * El saldo Umbani del pedido (2026-10-10): lo que el cliente pagó con su saldo
 * y lo que FALTA por cobrarle.
 *
 * ⚠️ El TOTAL no cambia —es el precio del pedido—, pero lo que el local cobra
 * en la puerta, lo que le transfieren o lo que pasó por la tarjeta sí: es
 * `porCobrar`. Pedirle el total a quien ya pagó una parte con saldo sería
 * cobrarle dos veces. Esa parte la pone Umbani y el lunes se le reconoce al
 * local en su liquidación.
 *
 * La misma resta que `porCobrarCents` del servidor, en centavos enteros.
 */
export const saldoDelPedido = (pedido: { total?: unknown; credit_cents?: unknown }) => {
  const saldoCents = Math.max(0, Math.round(numero(pedido.credit_cents)))
  const porCobrarCents = Math.max(0, Math.round(numero(pedido.total) * 100) - saldoCents)
  return { saldo: saldoCents / 100, porCobrar: porCobrarCents / 100 }
}

/**
 * Reparte el dinero de un pedido entre sus TRES dueños.
 *
 * Sobre el pedido #3 de staging ($11.98 de producto + $2.00 de envío):
 *
 *     el cliente paga ............. $15.18
 *     Umbani (servicio) ...........  $1.20   ← 10 % del PRODUCTO, no del total
 *     quien reparte (carrera) .....  $2.00
 *     el local por sus productos ..  $11.98
 *
 * ⚠️ **La carrera no es del local.** Decisión del dueño (2026-08-15, y
 * repetida el 2026-09-21 al ver la tarjeta): al motorizado le paga el CLIENTE
 * y la carrera es íntegra suya. Decir «Recibes $13.98» juntaba el plato con la
 * carrera en un solo número, que es justo lo que no puede pasar.
 *
 * ⚠️ **El servicio de Umbani se calcula solo sobre el producto**, nunca sobre
 * la carrera — lo hace `orders_stamp_pricing` con
 * `v_base = subtotal − discount`, sin envío. Aquí solo se refleja.
 *
 * ⚠️ `porLosProductos` se obtiene restando del TOTAL y no sumando al subtotal,
 * porque así vale para los DOS modos de margen sin preguntar cuál es: con
 * `on_top` el servicio se le sumó al cliente y con `absorbed` se le descontó al
 * comercio, pero en ambos lo que le queda al local por su comida es el total
 * menos el servicio y menos la carrera.
 *
 *     on_top   #70:  14.09 − 1.10 − 2.00 = 10.99  = su merchant_subtotal
 *     absorbed #57:  12.99 − 1.10 − 2.00 =  9.89  = su merchant_subtotal
 */
export const desgloseDelPedido = (pedido: DineroDelPedido): DesgloseDelPedido => {
  const servicio = numero(pedido.platform_markup)
  const reparto = numero(pedido.shipping)
  return {
    servicio,
    reparto,
    porLosProductos: aCentavos(numero(pedido.total) - servicio - reparto),
    servicioVaEncima: pedido.merchant_subtotal == null
      || numero(pedido.merchant_subtotal) >= numero(pedido.subtotal),
  }
}
