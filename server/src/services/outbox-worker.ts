// ═══════════════════════════════════════════════════════════════════════════
// EL WORKER QUE REINTENTA LOS AVISOS
//
// Solo se ocupa de lo que NO salió. El envío inmediato completa su propio
// evento, así que lo que este worker encuentra es exactamente lo que falló, o
// lo que se quedó a medias porque el proceso murió entre el reclamo y el
// envío.
//
// ⚠️ NO reclama nada. El reclamo (`customer_notified_status`) se gastó cuando
// el estado cambió, y volver a reclamar impediría el reintento — que es justo
// lo que este worker existe para hacer.
//
// ⚠️ Un evento sin pedido, sin negocio o sin teléfono se da por MUERTO, no se
// reintenta seis veces: reintentar lo que no puede salir solo retrasa el resto
// de la cola.
// ═══════════════════════════════════════════════════════════════════════════

import { notificarCambioDePedido, type PedidoParaAvisar } from './order-notify'
import { avisaAlClientePorWhatsApp } from '../config/avisos-al-cliente'
import type { BusinessRecord } from '../db/types'

interface OutboxDeps {
  lease(owner: string, limite: number, leaseS: number): Promise<Array<{
    id: string
    business_id: string
    aggregate_id: string
    payload: Record<string, unknown>
    lease_token: string | null
  }>>
  complete(id: string, token: string | null): Promise<boolean>
  fail(id: string, token: string, motivo: string): Promise<string>
  pedido(businessId: string, orderId: string): Promise<PedidoParaAvisar | null>
  negocio(businessId: string): Promise<BusinessRecord | null>
  enviar(negocio: BusinessRecord, pedido: PedidoParaAvisar, status: string): Promise<boolean>
  registrar(mensaje: string): void
  /**
   * ¿Se le escribe al cliente por WhatsApp? Apagado, lo que quede en la cola se
   * CIERRA sin enviar: no es un fallo, es una decisión (`config/avisos-al-cliente.ts`).
   */
  avisaAlCliente?: () => boolean
}

export const crearWorkerDeAvisos = (deps: OutboxDeps) =>
  async function procesarAvisosPendientes(
    owner = 'outbox', limite = 10, leaseS = 60,
  ): Promise<{ enviados: number; fallidos: number; muertos: number; apagados: number }> {
    const eventos = await deps.lease(owner, limite, leaseS)
    let enviados = 0
    let fallidos = 0
    let muertos = 0
    let apagados = 0

    for (const evento of eventos) {
      const token = evento.lease_token
      if (!token) continue
      if (deps.avisaAlCliente && !deps.avisaAlCliente()) {
        await deps.complete(evento.id, token).catch(() => { /* vencerá el lease y volverá aquí */ })
        apagados += 1
        continue
      }
      const status = String(evento.payload?.status || '')

      try {
        const pedido = await deps.pedido(evento.business_id, evento.aggregate_id)
        const negocio = pedido ? await deps.negocio(evento.business_id) : null

        // Sin pedido o sin negocio no hay nada que enviar, ni lo habrá:
        // reintentarlo seis veces solo retrasa el resto de la cola.
        if (!pedido || !negocio) {
          await deps.fail(evento.id, token, 'el pedido o el negocio ya no existen')
          muertos += 1
          continue
        }

        if (await deps.enviar(negocio, pedido, status)) {
          await deps.complete(evento.id, token)
          enviados += 1
        } else {
          const resultado = await deps.fail(evento.id, token, `no se pudo enviar: ${status}`)
          if (resultado === 'muerto') muertos += 1
          else fallidos += 1
        }
      } catch (error) {
        const motivo = error instanceof Error ? error.message : 'error desconocido'
        await deps.fail(evento.id, token, motivo).catch(() => { /* vencerá el lease */ })
        deps.registrar(`⚠️  outbox ${evento.id}: ${motivo}`)
        fallidos += 1
      }
    }

    return { enviados, fallidos, muertos, apagados }
  }

// Carga diferida, como el resto de servicios que hablan con los canales.
export const procesarAvisosPendientes = crearWorkerDeAvisos({
  avisaAlCliente: () => avisaAlClientePorWhatsApp(),
  lease(owner, limite, leaseS) {
    const db = require('../db') as typeof import('../db')
    return db.leaseOutboxEvents(owner, limite, leaseS)
  },
  complete(id, token) {
    const db = require('../db') as typeof import('../db')
    return db.completeOutboxEvent(id, token)
  },
  fail(id, token, motivo) {
    const db = require('../db') as typeof import('../db')
    return db.failOutboxEvent(id, token, motivo)
  },
  pedido(businessId, orderId) {
    const db = require('../db') as typeof import('../db')
    return db.getOrderForNotice(businessId, orderId) as Promise<PedidoParaAvisar | null>
  },
  negocio(businessId) {
    const db = require('../db') as typeof import('../db')
    return db.getBusinessById(businessId) as Promise<BusinessRecord | null>
  },
  enviar(negocio, pedido, status) {
    return notificarCambioDePedido(negocio, pedido, status)
  },
  registrar(mensaje) { console.warn(mensaje) },
})
