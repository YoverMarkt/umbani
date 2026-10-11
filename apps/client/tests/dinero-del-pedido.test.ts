import { describe, expect, it } from 'vitest'
import { desgloseDelPedido, elPedidoSeCobra, saldoDelPedido } from '../src/features/orders/dinero-del-pedido'

// ═══════════════════════════════════════════════════════════════════════════
// LA TARJETA DEL PEDIDO TIENE QUE CUADRAR A LA VISTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo vio el dueño en su pantalla de Pedidos el 2026-09-20:
//
//     Subtotal $10.99   Envío $2.00   Total $14.09
//
// $10.99 + $2.00 son $12.99. **Faltaban $1.10 sin explicar** — el margen de la
// plataforma, que no se pintaba en ninguna parte. El dinero estaba bien
// repartido; lo que estaba roto era lo que se leía.
//
// Los casos de abajo son pedidos REALES de producción, con sus cifras exactas.

describe('con `on_top`: el servicio se le suma al cliente', () => {
  // Pedido #70 de Monster Pizza, entregado el 2026-08-29.
  const pedido70 = {
    subtotal: 10.99, shipping: 2.00, total: 14.09,
    platform_markup: 1.10, merchant_subtotal: 10.99,
  }

  it('el local recibe SUS PRODUCTOS, sin la carrera', () => {
    // $14.09 − $1.10 de servicio − $2.00 de carrera. NO $12.99.
    expect(desgloseDelPedido(pedido70).porLosProductos).toBe(10.99)
  })

  it('y coincide con lo que la base selló como del comercio', () => {
    expect(desgloseDelPedido(pedido70).porLosProductos)
      .toBe(Number(pedido70.merchant_subtotal))
  })

  it('la carrera se informa aparte: es de quien reparte', () => {
    expect(desgloseDelPedido(pedido70).reparto).toBe(2.00)
  })

  it('el servicio va ENCIMA, así que se pinta sumando', () => {
    expect(desgloseDelPedido(pedido70).servicioVaEncima).toBe(true)
  })

  it('y las tres partes suman lo que paga el cliente', () => {
    const { servicio, reparto, porLosProductos } = desgloseDelPedido(pedido70)
    expect(porLosProductos + reparto + servicio).toBeCloseTo(Number(pedido70.total), 2)
  })

  it('el servicio es un porcentaje del PRODUCTO, no del total con carrera', () => {
    // 10 % de $10.99 = $1.10. De $12.99 serían $1.30, y nunca se cobró eso.
    const { servicio, porLosProductos } = desgloseDelPedido(pedido70)
    expect(servicio).toBeCloseTo(porLosProductos * 0.10, 2)
  })
})

describe('con `absorbed`: el servicio se le descuenta al comercio', () => {
  // Pedido #57 de Monster Pizza, del 2026-08-16, antes del cambio de modelo.
  // El cliente pagó lo mismo; al comercio se le recortó el margen del subtotal.
  const pedido57 = {
    subtotal: 10.99, shipping: 2.00, total: 12.99,
    platform_markup: 1.10, merchant_subtotal: 9.89,
  }

  it('la misma fórmula vale, y da lo que la base selló', () => {
    expect(desgloseDelPedido(pedido57).porLosProductos).toBe(9.89)
  })

  it('pero el servicio NO va encima: ya estaba dentro del subtotal', () => {
    // Pintarlo sumando dejaría la cuenta cuadrando al revés.
    expect(desgloseDelPedido(pedido57).servicioVaEncima).toBe(false)
  })
})

describe('los pedidos sin margen se quedan como estaban', () => {
  it('sin regla de margen no hay nada que enseñar', () => {
    const d = desgloseDelPedido({ subtotal: 15.50, total: 15.50, platform_markup: 0 })
    expect(d.servicio).toBe(0)
    expect(d.porLosProductos).toBe(15.50)
  })

  it('un pedido viejo sin el campo tampoco rompe', () => {
    const d = desgloseDelPedido({ subtotal: 18, total: 18 })
    expect(d.servicio).toBe(0)
    expect(d.porLosProductos).toBe(18)
  })

  it('quien retira en el local no paga carrera', () => {
    const d = desgloseDelPedido({
      subtotal: 11.98, shipping: 0, total: 13.18, platform_markup: 1.20,
    })
    expect(d.reparto).toBe(0)
    expect(d.porLosProductos).toBe(11.98)
  })
})

describe('los importes llegan como texto según el driver', () => {
  it('se normalizan antes de restar', () => {
    const d = desgloseDelPedido({
      subtotal: '10.99', shipping: '2.00', total: '14.09',
      platform_markup: '1.10', merchant_subtotal: '10.99',
    })
    expect(d.porLosProductos).toBe(10.99)
    expect(d.servicioVaEncima).toBe(true)
  })

  it('un valor ilegible cuenta como cero y no propaga NaN', () => {
    const d = desgloseDelPedido({ subtotal: 10, total: 10, platform_markup: 'nada' })
    expect(d.servicio).toBe(0)
    expect(d.porLosProductos).toBe(10)
  })
})

describe('la resta no arrastra céntimos de coma flotante', () => {
  it('$3.85 − $0.35 son exactamente $3.50', () => {
    // Pedido #23 de La Abuelita. En coma flotante esta resta da 3.4999…
    const d = desgloseDelPedido({
      subtotal: 3.50, shipping: 0, total: 3.85, platform_markup: 0.35, merchant_subtotal: 3.50,
    })
    expect(d.porLosProductos).toBe(3.50)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Y TIENE QUE CUADRAR CON FINANZAS
// ═══════════════════════════════════════════════════════════════════════════
//
// El caso que lo destapó: el pedido de la captura estaba **Expirado** y la
// tarjeta afirmaba igual «Servicio $1.20 · Recibes $13.98». Pero un pedido
// expirado nunca llega a `sales`, y `platform_markup_summary` —lo que alimenta
// la comisión del mes y la tarjeta de Finanzas— suma SOLO ventas completadas.
//
// O sea: la plataforma no factura ese servicio y el local no recibe nada.
// Sumando los «Servicio» que se veían en pantalla nunca salía el número de
// Finanzas.

describe('un pedido que murió no mueve dinero', () => {
  it.each(['expirado', 'cancelado', 'rechazado'])('%s no se cobra', (status) => {
    expect(elPedidoSeCobra(status)).toBe(false)
  })
})

describe('un pedido vivo o entregado sí cuenta', () => {
  it.each([
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado',
    'aceptado', 'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
  ])('%s se cobra', (status) => {
    expect(elPedidoSeCobra(status)).toBe(true)
  })

  it('un estado desconocido se cobra: falla ABIERTO', () => {
    // Si mañana nace un estado y nadie toca esto, es preferible enseñar el
    // importe de más que esconderle al dueño un dinero que sí recibe.
    expect(elPedidoSeCobra('inventado')).toBe(true)
    expect(elPedidoSeCobra(null)).toBe(true)
    expect(elPedidoSeCobra(undefined)).toBe(true)
  })

  it('no se deja engañar por espacios', () => {
    expect(elPedidoSeCobra('  expirado  ')).toBe(false)
  })
})

// ── EL SALDO UMBANI (2026-10-10) ──────────────────────────────────────────
// El total no cambia; lo que el local COBRA sí. Pedirle el total a quien ya
// pagó una parte con saldo sería cobrarle dos veces.
describe('el saldo Umbani: lo que falta por cobrar', () => {
  it('es el total menos lo pagado con saldo, al centavo', () => {
    expect(saldoDelPedido({ total: '8.00', credit_cents: 110 })).toEqual({ saldo: 1.1, porCobrar: 6.9 })
    expect(saldoDelPedido({ total: 15.18, credit_cents: 500 })).toEqual({ saldo: 5, porCobrar: 10.18 })
  })

  it('sin saldo, o con un dato roto, se cobra el total y nunca algo negativo', () => {
    expect(saldoDelPedido({ total: 15.18 })).toEqual({ saldo: 0, porCobrar: 15.18 })
    expect(saldoDelPedido({ total: 15.18, credit_cents: null })).toEqual({ saldo: 0, porCobrar: 15.18 })
    expect(saldoDelPedido({ total: 15.18, credit_cents: -40 })).toEqual({ saldo: 0, porCobrar: 15.18 })
    expect(saldoDelPedido({ total: 5, credit_cents: 900 })).toEqual({ saldo: 9, porCobrar: 0 })
  })

  it('el desglose del local NO cambia: su comida se le paga entera', () => {
    const conSaldo = desgloseDelPedido({ subtotal: 11.98, shipping: 2, total: 15.18, platform_markup: 1.2, merchant_subtotal: 11.98 })
    expect(conSaldo.porLosProductos).toBe(11.98)
  })
})
