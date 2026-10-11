// ═══════════════════════════════════════════════════════════════════════════
// LO QUE FALTA POR COBRAR DE UN PEDIDO (2026-10-10)
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde que el cliente puede pagar una parte con su SALDO UMBANI, el total del
// pedido y lo que hay que cobrarle dejaron de ser lo mismo. El total sigue
// siendo el precio del pedido —de él cuelgan los reportes, la comisión y el
// libro—; lo que se cobra es el total MENOS lo pagado con saldo.
//
// ⚠️ La regla la decide la BASE (`orders.credit_cents`, que pone
// `create_storefront_order`). Aquí solo se lee, en centavos enteros, para que
// todo el que cobra —el comprobante, el aviso al dueño, la app— reste igual.
// Un llamador que leyera `total` a secas cobraría de más a quien usó su saldo.
//
// No importa nada a propósito: `precio-para-el-cliente.ts` lo usa, y si este
// importara de allí se cerraría un ciclo.

/** Un monto de la base (`numeric` en dólares) en centavos enteros. */
const centavos = (monto: unknown): number => Math.round((Number(monto) || 0) * 100)

/** Lo justo de un pedido para saber cuánto falta por cobrar. */
export interface DineroDelPedido {
  total?: unknown
  credit_cents?: unknown
}

/** Lo que el cliente pagó con su saldo Umbani, en centavos (nunca negativo). */
export const saldoUsadoCents = (pedido: DineroDelPedido): number =>
  Math.max(0, Math.round(Number(pedido.credit_cents) || 0))

/** Lo que FALTA por cobrar, en centavos: el total menos lo pagado con saldo. */
export const porCobrarCents = (pedido: DineroDelPedido): number =>
  Math.max(0, centavos(pedido.total) - saldoUsadoCents(pedido))

/** Lo mismo en dólares, para quien compara con un monto escrito (un comprobante). */
export const porCobrar = (pedido: DineroDelPedido): number => porCobrarCents(pedido) / 100
