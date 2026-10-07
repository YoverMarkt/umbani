import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLaTienda } from './fuente-de-la-tienda.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LAS DEFENSAS SON PARA TODOS LOS LOCALES
// ═══════════════════════════════════════════════════════════════════════════
//
// Pregunta del dueño (2026-09-03): «¿esto ya aplica para futuros locales, ya
// sean de mini app o de menú de chat? Estas cosas deben ser para todos, ya que
// es una app para todos y la app tiene que brindar la seguridad para todos».
//
// La respuesta HOY es que sí, y se comprobó una a una contra producción. Lo
// que esta prueba protege es que siga siéndolo MAÑANA: el día que alguien
// añada «salvo en los locales de chat» a cualquiera de estas piezas, la
// seguridad se parte en dos y nadie se entera hasta que pase algo.
//
// ⚠️ Por qué se sostiene: los DOS caminos —la mini app y el checkout del
// chat— crean el pedido con la MISMA RPC, `create_storefront_order`, que fija
// `source = 'storefront'` como literal. Todas las defensas cuelgan de ahí, no
// del tipo de local.

const sql = readFileSync('schema.sql', 'utf8')

/** Las doce piezas que protegen al local y al cliente. */
const DEFENSAS = [
  'orders_reject_blocked',
  'orders_reject_platform_blocked',
  'orders_limit_open_per_customer',
  'orders_limit_per_hour',
  'orders_enforce_min_amount',
  'orders_release_shopping_lock',
  'orders_clear_customer_strikes',
  'register_rejected_receipt',
  'register_unpaid_expiry',
  'block_customer_temporarily',
  'storefront_customer_block_state',
  'expire_unpaid_orders',
]

/** El cuerpo de una función, desde su `create or replace` hasta su `$$;`. */
const cuerpoDe = (nombre) => {
  const desde = sql.lastIndexOf(`create or replace function public.${nombre}(`)
  expect(desde, `no se encontró ${nombre} en schema.sql`).toBeGreaterThan(-1)
  const hasta = sql.indexOf('\n$$;', desde)
  return sql.slice(desde, hasta)
}

describe('ninguna defensa mira el TIPO del local', () => {
  it.each(DEFENSAS)('%s no distingue mini app de chat', (nombre) => {
    const cuerpo = cuerpoDe(nombre)
    // Un local de chat y uno de mini app se distinguen por estas tres. Que una
    // defensa las mire significaría que hay clientes protegidos y clientes no.
    expect(cuerpo, `${nombre} mira chat_mode`).not.toMatch(/chat_mode/)
    expect(cuerpo, `${nombre} mira pide_en_chat`).not.toMatch(/pide_en_chat/)
    expect(cuerpo, `${nombre} mira businesses.type`).not.toMatch(/\btype\b/)
  })
})

describe('los dos caminos crean el pedido igual', () => {
  it('solo la TIENDA crea pedidos, y por la misma RPC', () => {
    // Desde que el pedido por chat se retiró (2026-09-15) hay una sola puerta.
    // Si apareciera otra, la mitad de las defensas dejarían de alcanzarla sin
    // que ninguna prueba fallara: todas cuelgan de `source = 'storefront'`,
    // que esta RPC fija como literal.
    const tienda = fuenteDeLaTienda()
    const chat = readFileSync('src/services/inbound-webhook.ts', 'utf8')
    const repo = readFileSync('src/db/repositories/storefront.ts', 'utf8')

    expect(repo).toContain("'create_storefront_order'")
    expect(tienda).toContain('createStorefrontOrder')
    expect(chat, 'el número de la plataforma no crea pedidos')
      .not.toContain('createStorefrontOrder')
  })

  it('la RPC fija el source, no lo recibe como parámetro', () => {
    // Un `source` parametrizable sería una puerta para crear pedidos que
    // ninguna defensa mira.
    const cuerpo = cuerpoDe('create_storefront_order')
    expect(cuerpo).toContain("'storefront'")
    expect(cuerpo).not.toMatch(/p_source/)
  })
})

describe('el bloqueo se comprueba ANTES de elegir el camino', () => {
  it('un bloqueado no llega ni al enlace de la tienda', () => {
    // Si el bloqueo se mirara después de entregar el local, el bloqueado se
    // llevaría su enlace, armaría el carrito entero y solo lo frenaría el
    // rechazo al confirmar — el peor momento para enterarse.
    const fuente = readFileSync('src/services/marketplace-entry.ts', 'utf8')
    const entrega = fuente.slice(fuente.indexOf('async function entregarLocal'))
    const bloqueo = entrega.indexOf('isContactBlocked')
    const enlace = entrega.indexOf('mandarElEnlace')
    expect(bloqueo).toBeGreaterThan(-1)
    expect(enlace).toBeGreaterThan(-1)
    expect(bloqueo, 'el bloqueo se comprueba DESPUÉS de entregar el enlace')
      .toBeLessThan(enlace)
  })
})
