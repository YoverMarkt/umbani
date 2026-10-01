// ═══════════════════════════════════════════════════════════════════════════
// EL CUADRE DIARIO CONTRA PAYPHONE
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que faltaba del PR A2 de las liquidaciones (2026-09-29). Nuestra base dice
// qué se cobró y qué se devolvió; esto le pregunta a PayPhone, cobro por cobro,
// si dice lo mismo. Nació de dos cosas que se vieron el 2026-09-28:
//
//   · el portal de pruebas de PayPhone enseñaba «Pendiente» un cobro que su API
//     daba por DEVUELTO — la pantalla de un tercero no sirve para cuadrar;
//   · una devolución se pidió a las 22:06, pasada la hora límite de las 20:00
//     que dice su documentación. En el sandbox salió; en producción podría
//     contestar «sí» y no hacerse, y el cliente creería que tiene su dinero.
//
// ⚠️ NUNCA MUEVE DINERO NI CAMBIA EL ESTADO DE UN COBRO. Compara, guarda el
// resultado y AVISA (registro de errores, categoría «pagos», que el vigía manda
// por correo). Lo que haya que devolver o corregir lo decide una persona: un
// cuadre que corrigiera solo podría devolver dos veces el mismo cobro.
//
// ⚠️ Una vez al DÍA, a partir de las 6:00 de Ecuador. La tarea mira cada hora
// y solo actúa si hoy aún no cuadró: si el servidor estaba caído a las 6, el
// cuadre sale igual un rato después.
//
// ⚠️ A 15 consultas por minuto como mucho. PayPhone admite 30 y la tarea de
// cobros comparte ese límite: el cuadre nunca puede dejarla sin consultas.

import { leerConfiguracionPayphone } from '../config/payphone'
import type { ConfiguracionPayphone } from '../config/payphone'
import type { ClientePayphone, FalloDePayphone, RespuestaDeCobro } from '../integrations/payphone'
import type { CobroPorCuadrar, ResumenDelCuadre } from '../db/repositories/payments'

/** Desde qué hora de Ecuador se cuadra el día. */
export const HORA_DEL_CUADRE = 6
/** Cuántos cobros como mucho en una vuelta. */
export const COBROS_POR_VUELTA = 120
/** Pausa entre consultas: 4 s = 15 por minuto, la mitad del límite de PayPhone. */
export const PAUSA_ENTRE_CONSULTAS_MS = 4_000

type Consulta = RespuestaDeCobro | FalloDePayphone | { tipo: 'no_existe' }

export type VeredictoDelCuadre =
  | { resultado: 'cuadra' }
  | { resultado: 'descuadre'; detalle: string; grave: boolean }
  /** En camino: lo resuelve la tarea de cobros, no hay nada que avisar aún. */
  | { resultado: 'pendiente' }
  /** PayPhone no contestó: se vuelve a preguntar en la próxima vuelta. */
  | { resultado: 'sin_respuesta' }

const dolares = (centavos: number | null | undefined) => `$${((centavos ?? 0) / 100).toFixed(2)}`

/**
 * ¿Dice PayPhone lo mismo que nuestra base? Pura: sin red ni base.
 *
 * `statusCode` de PayPhone: 1 pendiente · 2 cancelado (rechazado o devuelto) ·
 * 3 aprobado. «No existe»: nunca se llegó a presentar una tarjeta.
 */
export function compararCobro(nuestro: Pick<CobroPorCuadrar, 'status' | 'amount_cents' | 'captured_cents'>, consulta: Consulta): VeredictoDelCuadre {
  if (consulta.tipo === 'fallo') return { resultado: 'sin_respuesta' }
  const enPayphone = consulta.tipo === 'no_existe' ? 'no_existe' : consulta.statusCode
  const cobradoAlla = enPayphone === 3

  switch (nuestro.status) {
    case 'aprobado': {
      if (!cobradoAlla) {
        return {
          resultado: 'descuadre',
          grave: true,
          detalle: enPayphone === 'no_existe'
            ? 'Aprobado aquí, pero PayPhone no tiene este cobro: el pedido se dio por pagado sin dinero.'
            : 'Aprobado aquí y NO cobrado en PayPhone: el pedido se dio por pagado sin dinero.',
        }
      }
      const aqui = nuestro.captured_cents ?? nuestro.amount_cents
      const alla = consulta.tipo === 'respuesta' ? consulta.capturedCents : null
      if (alla !== null && alla !== aqui) {
        return {
          resultado: 'descuadre',
          grave: true,
          detalle: `PayPhone cobró ${dolares(alla)} y aquí consta ${dolares(aqui)}.`,
        }
      }
      return { resultado: 'cuadra' }
    }

    case 'devuelto':
    case 'no_confirmado':
      // ⚠️ El caso que motivó todo esto: una devolución que PayPhone no hizo.
      return cobradoAlla
        ? {
          resultado: 'descuadre',
          grave: true,
          detalle: 'Devuelto aquí, pero PayPhone lo sigue teniendo COBRADO: hay que devolverlo a mano.',
        }
        : { resultado: 'cuadra' }

    case 'rechazado':
    case 'caducado':
      // ⚠️ El peor: el cliente pagó y el pedido no se dio por pagado.
      return cobradoAlla
        ? {
          resultado: 'descuadre',
          grave: true,
          detalle: `PayPhone lo COBRÓ y aquí consta «${nuestro.status}»: el cliente pagó y el pedido no se dio por pagado.`,
        }
        : { resultado: 'cuadra' }

    case 'por_devolver':
      // Cobrado y por devolver: es trabajo de la tarea de cobros, que lo
      // revierte en segundos. Si PayPhone ya lo devolvió, aquí quedó atrás.
      return cobradoAlla
        ? { resultado: 'pendiente' }
        : {
          resultado: 'descuadre',
          grave: false,
          detalle: 'PayPhone ya lo devolvió, pero aquí sigue «por devolver».',
        }

    case 'devolucion_manual':
      // Lo marcó la tarea cuando PayPhone no dejó revertirlo. Mientras siga
      // cobrado allá, se recuerda cada día: alguien tiene que devolverlo.
      return cobradoAlla
        ? { resultado: 'descuadre', grave: true, detalle: 'Sigue cobrado en PayPhone: falta devolverlo a mano.' }
        : { resultado: 'cuadra' }

    case 'iniciado':
    case 'confirmando':
      return cobradoAlla
        ? {
          resultado: 'descuadre',
          grave: true,
          detalle: 'PayPhone lo COBRÓ y aquí sigue sin confirmar: el pedido no se dio por pagado.',
        }
        : { resultado: 'pendiente' }

    default:
      return { resultado: 'descuadre', grave: false, detalle: `Estado desconocido aquí: «${nuestro.status}».` }
  }
}

/** La fecha y la hora de ahora en Ecuador. */
export function ahoraEnEcuador(ahora: Date): { fecha: string; hora: number } {
  const fecha = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
  const hora = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guayaquil', hour: '2-digit', hourCycle: 'h23',
  }).format(ahora))
  return { fecha, hora }
}

export interface DependenciasDelCuadre {
  configuracion(): ConfiguracionPayphone | null
  payphone(config: ConfiguracionPayphone): Pick<ClientePayphone, 'consultar'>
  base: {
    paymentsToReconcile(environment: ConfiguracionPayphone['modo'], limite: number): Promise<CobroPorCuadrar[]>
    markPaymentReconciled(id: string, resultado: 'cuadra' | 'descuadre', detalle: string | null): Promise<boolean>
    leerUltimoCuadre(): Promise<ResumenDelCuadre | null>
    guardarUltimoCuadre(resumen: ResumenDelCuadre): Promise<void>
  }
  /** Alerta en el registro de errores, categoría «pagos». */
  alertar(input: { businessId?: string | null; code: string; message: string; context?: Record<string, unknown> }): Promise<void>
  registrar(linea: string): void
  esperar(ms: number): Promise<void>
  ahora?(): Date
}

export function crearCuadre(deps: DependenciasDelCuadre) {
  const ahora = () => (deps.ahora ? deps.ahora() : new Date())
  const alertar = (input: Parameters<DependenciasDelCuadre['alertar']>[0]) => (
    deps.alertar(input).catch(() => { /* la alerta no puede tumbar el cuadre */ })
  )

  /**
   * Cuadra el día si toca. `forzar`: aunque hoy ya se haya hecho o sea antes de
   * las 6 (lo usa la verificación a mano). Nunca lanza.
   */
  return async function cuadrarConPayphone(opciones: { forzar?: boolean } = {}): Promise<ResumenDelCuadre | null> {
    const config = deps.configuracion()
    if (!config) return null
    try {
      const { fecha, hora } = ahoraEnEcuador(ahora())
      if (!opciones.forzar) {
        if (hora < HORA_DEL_CUADRE) return null
        const ultimo = await deps.base.leerUltimoCuadre()
        if (ultimo?.fecha === fecha) return null
      }

      const cobros = await deps.base.paymentsToReconcile(config.modo, COBROS_POR_VUELTA)
      const cliente = deps.payphone(config)
      const resumen: ResumenDelCuadre = { fecha, at: ahora().toISOString(), revisados: 0, descuadres: 0, sinRespuesta: 0 }

      for (const [i, cobro] of cobros.entries()) {
        if (i > 0) await deps.esperar(PAUSA_ENTRE_CONSULTAS_MS)
        const veredicto = compararCobro(cobro, await cliente.consultar(cobro.client_transaction_id))
        if (veredicto.resultado === 'sin_respuesta') { resumen.sinRespuesta += 1; continue }
        if (veredicto.resultado === 'pendiente') continue
        resumen.revisados += 1
        if (veredicto.resultado === 'cuadra') {
          await deps.base.markPaymentReconciled(cobro.id, 'cuadra', null)
          continue
        }
        resumen.descuadres += 1
        await deps.base.markPaymentReconciled(cobro.id, 'descuadre', veredicto.detalle)
        await alertar({
          businessId: cobro.business_id,
          code: veredicto.grave ? 'cuadre_payphone_grave' : 'cuadre_payphone',
          message: `Cuadre con PayPhone · ${cobro.business_name} · pedido #${cobro.order_number ?? '?'}: ${veredicto.detalle}`,
          context: {
            referencia: cobro.client_transaction_id,
            payphone: cobro.provider_transaction_id,
            pedido: cobro.order_id,
            estado_aqui: cobro.status,
            monto: dolares(cobro.captured_cents ?? cobro.amount_cents),
          },
        })
      }

      await deps.base.guardarUltimoCuadre(resumen)
      deps.registrar(`🧮 [cuadre PayPhone] ${resumen.fecha}: ${resumen.revisados} revisado(s), `
        + `${resumen.descuadres} descuadre(s), ${resumen.sinRespuesta} sin respuesta`)
      return resumen
    } catch (error) {
      await alertar({
        code: 'cuadre_payphone_fallo',
        message: `El cuadre diario con PayPhone no se pudo hacer: ${error instanceof Error ? error.message : String(error)}`,
      })
      return null
    }
  }
}

// ── La instancia que usa el servidor de verdad ──────────────────────────────
//
// Perezosa: cargar este módulo no abre la base ni lee credenciales.
let enVivo: ReturnType<typeof crearCuadre> | null = null

export function cuadrarConPayphone(opciones: { forzar?: boolean } = {}) {
  if (!enVivo) {
    const db = require('../db') as typeof import('../db')
    const { recordError } = require('./error-log') as typeof import('./error-log')
    const { crearClientePayphone } = require('../integrations/payphone') as typeof import('../integrations/payphone')
    enVivo = crearCuadre({
      configuracion: () => leerConfiguracionPayphone(),
      payphone: config => crearClientePayphone({ token: config.token, storeId: config.storeId }),
      base: db,
      alertar: input => recordError({ ...input, businessId: input.businessId ?? null, category: 'pagos' }).then(() => undefined),
      registrar: linea => console.log(linea),
      esperar: ms => new Promise(resolve => setTimeout(resolve, ms)),
    })
  }
  return enVivo(opciones)
}
