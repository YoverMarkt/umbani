// ═══════════════════════════════════════════════════════════════════════════
// EL COBRO CON TARJETA: INICIAR, CONFIRMAR Y NO DEJAR NINGUNO EN EL AIRE
// ═══════════════════════════════════════════════════════════════════════════
//
// PayPhone no avisa. Redirige al TELÉFONO del cliente a nuestra URL, y si
// nadie llama a su `Confirm` en 5 minutos, devuelve el dinero solo. Así que
// hay dos caminos hasta `confirmar`, y cualquiera de los dos basta:
//
//   · la REDIRECCIÓN, que es la vía rápida: el cliente vuelve y ve el
//     resultado en un par de segundos;
//   · la TAREA del servidor (`procesarPendientes`), que corre sola cada pocos
//     segundos y busca por nuestra referencia los cobros cuyo teléfono no
//     volvió — se le fue el 4G, cerró la pestaña, entró en un túnel.
//
// ⚠️ Nada de aquí decide el dinero. La base dice si se confirma
// (`claim_card_payment`) ANTES de llamar a PayPhone, y si lo cobrado cuadra
// al centavo (`settle_card_payment`) DESPUÉS. Este archivo solo mueve las
// respuestas de un lado a otro y avisa cuando algo no cuadra.
//
// ⚠️ NUNCA lanza hacia quien lo llama: la redirección tiene que llevar al
// cliente a algún sitio, y la tarea tiene que seguir con el siguiente cobro.

import { leerConfiguracionPayphone } from '../config/payphone'
import type { ConfiguracionPayphone, ModoPayphone } from '../config/payphone'
import type {
  ClientePayphone, FalloDePayphone, RespuestaDeCobro,
} from '../integrations/payphone'
import type { CobroPendiente, RespuestaDelCobro } from '../db/repositories/payments'

/** Lo que el servicio necesita de la base. */
export interface BaseDelCobro {
  startCardPayment(input: {
    businessId: string
    orderId: string
    contactPhone: string
    environment: ModoPayphone
  }): Promise<RespuestaDelCobro>
  claimCardPayment(ref: string, id: string | null): Promise<RespuestaDelCobro>
  settleCardPayment(input: {
    clientTransactionId: string
    providerTransactionId: string
    statusCode: number
    capturedCents: number | null
    currency: string | null
    authorizationCode?: string | null
    cardBrand?: string | null
    lastDigits?: string | null
    detail?: string | null
  }): Promise<RespuestaDelCobro>
  leaseCardPayments(limite: number, leaseS: number): Promise<CobroPendiente[]>
  expireCardPayment(ref: string, detalle?: string): Promise<boolean>
  finishCardRefund(ref: string, revertido: boolean, detalle?: string): Promise<boolean>
}

export interface DependenciasDelCobro {
  configuracion(): ConfiguracionPayphone | null
  payphone(config: ConfiguracionPayphone): ClientePayphone
  base: BaseDelCobro
  /** La URL pública del servidor (`BASE_URL`). */
  urlPublica(): string | null
  /** Alerta en el registro de errores, categoría «pagos». */
  alertar(input: { businessId?: string | null; code: string; message: string; context?: Record<string, unknown> }): Promise<void>
  /** El WhatsApp al dueño, si lo tiene encendido. Nunca lanza. */
  avisarAlDueno(businessId: string, orderId: string): Promise<unknown>
  ahora?(): number
}

export type ResultadoAlIniciar =
  | { resultado: 'ok'; url: string }
  | { resultado: 'no_disponible' | 'no_encontrado' | 'no_es_tarjeta' | 'ya_pagado'
    | 'no_cobrable' | 'demasiados_intentos' | 'fallo_proveedor' }

export type ResultadoAlConfirmar =
  | 'aprobado' | 'rechazado' | 'pendiente' | 'devolver' | 'no_confirmado' | 'no_encontrado' | 'final'

/** Solo lo que genera la base: hex o guiones, entre 8 y 50. */
export const REFERENCIA_VALIDA = /^[A-Za-z0-9-]{8,50}$/
/** El id de PayPhone es un entero. */
export const ID_PAYPHONE_VALIDO = /^[0-9]{1,19}$/

/** La página de PayPhone vale 10 minutos; se da uno de margen. */
const CADUCA_SIN_PAGO_MS = 11 * 60 * 1000
/** Una devolución que sigue sin salir al día siguiente la hace una persona. */
const DEVOLUCION_SE_RINDE_MS = 24 * 60 * 60 * 1000

const esFallo = (valor: unknown): valor is FalloDePayphone => (
  Boolean(valor) && (valor as { tipo?: string }).tipo === 'fallo'
)

export function crearPagosConTarjeta(deps: DependenciasDelCobro) {
  const ahora = () => (deps.ahora ? deps.ahora() : Date.now())

  const alertar = (input: Parameters<DependenciasDelCobro['alertar']>[0]) => (
    deps.alertar(input).catch(() => { /* la alerta no puede tumbar el cobro */ })
  )

  /** Asienta en la base lo que dijo PayPhone y reacciona al veredicto. */
  async function asentar(
    referencia: string,
    id: string,
    cobro: RespuestaDeCobro,
  ): Promise<ResultadoAlConfirmar> {
    const veredicto = await deps.base.settleCardPayment({
      clientTransactionId: referencia,
      providerTransactionId: cobro.transactionId || id,
      statusCode: cobro.statusCode,
      capturedCents: cobro.capturedCents,
      // PayPhone Ecuador liquida solo en dólares; si el campo no viene, el
      // cobro se preparó en USD y la base lo compara igual.
      currency: cobro.currency || 'USD',
      authorizationCode: cobro.authorizationCode,
      cardBrand: cobro.cardBrand,
      lastDigits: cobro.lastDigits,
      detail: cobro.mensaje,
    })

    switch (veredicto.result) {
      case 'approved':
        if (veredicto.businessId && veredicto.orderId) {
          // El dueño se entera AHORA, cuando el dinero existe, y no al crearse
          // un pedido que quizá nadie pague.
          void Promise.resolve(deps.avisarAlDueno(veredicto.businessId, veredicto.orderId)).catch(() => {})
        }
        return 'aprobado'
      case 'rejected':
        return 'rechazado'
      case 'pending':
        return 'pendiente'
      case 'refund':
        await alertar({
          businessId: veredicto.businessId,
          code: 'tarjeta_a_devolver',
          message: `Cobro con tarjeta a devolver: ${veredicto.reason || 'sin motivo'}`,
          context: { referencia, pedido: veredicto.orderId },
        })
        return 'devolver'
      case 'mismatch':
        await alertar({
          businessId: veredicto.businessId,
          code: 'tarjeta_id_ajeno',
          message: 'Llegó un id de PayPhone distinto al del cobro: posible URL manipulada',
          context: { referencia, pedido: veredicto.orderId },
        })
        return 'no_confirmado'
      case 'final':
        return 'final'
      case 'not_found':
        return 'no_encontrado'
      default:
        return 'pendiente'
    }
  }

  /**
   * Confirma UN cobro. Lo llaman la redirección y la tarea; es idempotente.
   */
  async function confirmar(referencia: string, idPayphone: string | null): Promise<{
    resultado: ResultadoAlConfirmar
    orderId?: string
    businessId?: string
  }> {
    if (!REFERENCIA_VALIDA.test(referencia)) return { resultado: 'no_encontrado' }
    const id = idPayphone && ID_PAYPHONE_VALIDO.test(idPayphone) ? idPayphone : null
    try {
      const reclamo = await deps.base.claimCardPayment(referencia, id)
      const donde = { orderId: reclamo.orderId, businessId: reclamo.businessId }
      if (reclamo.result === 'not_found') return { resultado: 'no_encontrado' }
      if (reclamo.result === 'final') return { resultado: 'final', ...donde }
      if (reclamo.result === 'dont_confirm') {
        // No se llama a PayPhone: sin `Confirm`, él devuelve el dinero solo.
        return { resultado: 'no_confirmado', ...donde }
      }
      if (reclamo.result === 'mismatch') {
        await alertar({
          businessId: reclamo.businessId,
          code: 'tarjeta_id_ajeno',
          message: 'Llegó un id de PayPhone distinto al del cobro: posible URL manipulada',
          context: { referencia },
        })
        return { resultado: 'no_confirmado', ...donde }
      }
      if (reclamo.result !== 'confirm') return { resultado: 'pendiente', ...donde }

      const config = deps.configuracion()
      const idFirme = reclamo.providerTransactionId || id
      // Sin el id de PayPhone no hay qué confirmar todavía: la tarea lo busca
      // por nuestra referencia. No es una alerta, es el camino normal cuando
      // el teléfono no trae el `id`.
      if (!idFirme) return { resultado: 'pendiente', ...donde }
      // ⚠️ Un cobro abierto en un modo solo lo confirma un servidor en ESE modo.
      if (!config || config.modo !== reclamo.environment) {
        await alertar({
          businessId: reclamo.businessId,
          code: 'tarjeta_sin_configuracion',
          message: 'Hay un cobro con tarjeta que confirmar y PayPhone no está configurado en su modo',
          context: { referencia, modo_del_cobro: reclamo.environment, modo_del_servidor: config?.modo ?? null },
        })
        return { resultado: 'pendiente', ...donde }
      }

      const cliente = deps.payphone(config)
      let respuesta = await cliente.confirmar(idFirme, referencia)
      // «Ya estaba confirmada» o una respuesta que se perdió: se pregunta por
      // la referencia en vez de adivinar.
      if (esFallo(respuesta) && respuesta.definitivo) {
        const consulta = await cliente.consultar(referencia)
        if (consulta.tipo === 'respuesta') respuesta = consulta
      }
      if (esFallo(respuesta) || respuesta.tipo !== 'respuesta') {
        return { resultado: 'pendiente', ...donde }
      }
      return { resultado: await asentar(referencia, idFirme, respuesta), ...donde }
    } catch (error) {
      await alertar({
        code: 'tarjeta_error_al_confirmar',
        message: `No se pudo confirmar un cobro con tarjeta: ${error instanceof Error ? error.message : String(error)}`,
        context: { referencia },
      })
      return { resultado: 'pendiente' }
    }
  }

  /**
   * La mini app pide pagar un pedido. Devuelve la URL de PayPhone.
   */
  async function iniciar(input: {
    businessId: string
    orderId: string
    telefono: string
    nombreDelLocal: string
  }): Promise<ResultadoAlIniciar> {
    const config = deps.configuracion()
    const base = deps.urlPublica()
    if (!config || !base) return { resultado: 'no_disponible' }

    try {
      const inicio = await deps.base.startCardPayment({
        businessId: input.businessId,
        orderId: input.orderId,
        contactPhone: input.telefono,
        environment: config.modo,
      })
      switch (inicio.result) {
        case 'ok': break
        case 'not_found': return { resultado: 'no_encontrado' }
        case 'not_card': return { resultado: 'no_es_tarjeta' }
        case 'already_paid': return { resultado: 'ya_pagado' }
        case 'not_payable': return { resultado: 'no_cobrable' }
        case 'too_many_attempts': return { resultado: 'demasiados_intentos' }
        case 'card_unavailable': return { resultado: 'no_disponible' }
        default: return { resultado: 'no_disponible' }
      }
      const referencia = inicio.clientTransactionId
      const centavos = inicio.amountCents
      if (!referencia || !centavos) return { resultado: 'no_disponible' }

      const retorno = `${base.replace(/\/+$/, '')}/pagos/payphone/retorno`
      const preparado = await deps.payphone(config).preparar({
        referencia,
        centavos,
        urlRespuesta: retorno,
        urlCancelacion: `${retorno}?cancelado=1&clientTransactionId=${encodeURIComponent(referencia)}`,
        motivo: `Pedido #${inicio.orderNumber ?? ''} · ${input.nombreDelLocal}`.trim(),
      })
      if (esFallo(preparado)) {
        await alertar({
          businessId: input.businessId,
          code: 'tarjeta_no_se_preparo',
          message: `PayPhone no preparó el cobro: ${preparado.mensaje}`,
          context: { referencia, pedido: input.orderId },
        })
        return { resultado: 'fallo_proveedor' }
      }
      return { resultado: 'ok', url: preparado.urlTarjeta }
    } catch (error) {
      await alertar({
        businessId: input.businessId,
        code: 'tarjeta_error_al_iniciar',
        message: `No se pudo iniciar un cobro con tarjeta: ${error instanceof Error ? error.message : String(error)}`,
        context: { pedido: input.orderId },
      })
      return { resultado: 'fallo_proveedor' }
    }
  }

  /** Devuelve UN cobro que no debía quedarse. */
  async function devolver(cobro: CobroPendiente, cliente: ClientePayphone): Promise<'devuelto' | 'manual' | 'reintentar'> {
    const ref = cobro.client_transaction_id
    if (!cobro.provider_transaction_id) {
      await deps.base.finishCardRefund(ref, false, 'Sin id de PayPhone para revertir: devolver a mano')
      await alertar({ businessId: cobro.business_id, code: 'tarjeta_devolucion_manual',
        message: 'Un cobro con tarjeta hay que devolverlo A MANO (sin id de PayPhone)', context: { referencia: ref } })
      return 'manual'
    }
    const reverso = await cliente.revertir(cobro.provider_transaction_id)
    if (!esFallo(reverso)) {
      await deps.base.finishCardRefund(ref, true)
      return 'devuelto'
    }
    const viejo = ahora() - new Date(cobro.created_at).getTime() > DEVOLUCION_SE_RINDE_MS
    if (reverso.definitivo || viejo) {
      await deps.base.finishCardRefund(ref, false, `PayPhone no lo revirtió: ${reverso.mensaje}`)
      await alertar({ businessId: cobro.business_id, code: 'tarjeta_devolucion_manual',
        message: `Un cobro con tarjeta hay que devolverlo A MANO: ${reverso.mensaje}`,
        context: { referencia: ref, pedido: cobro.order_id } })
      return 'manual'
    }
    return 'reintentar'
  }

  /**
   * La tarea: cada cobro vivo acaba resuelto, pase lo que pase con el teléfono.
   */
  async function procesarPendientes(limite = 5): Promise<Record<string, number>> {
    const cuenta: Record<string, number> = {}
    const sumar = (clave: string) => { cuenta[clave] = (cuenta[clave] || 0) + 1 }
    const config = deps.configuracion()
    if (!config) return cuenta

    let cobros: CobroPendiente[] = []
    try {
      cobros = await deps.base.leaseCardPayments(limite, 45)
    } catch (error) {
      await alertar({ code: 'tarjeta_cola', message: `La cola de cobros no respondió: ${error instanceof Error ? error.message : String(error)}` })
      return cuenta
    }

    const cliente = deps.payphone(config)
    for (const cobro of cobros) {
      try {
        // ⚠️ Un cobro de pruebas no lo toca un servidor en producción, ni al revés.
        if (cobro.environment !== config.modo) { sumar('otro_modo'); continue }
        const ref = cobro.client_transaction_id

        if (cobro.status === 'por_devolver') {
          sumar(await devolver(cobro, cliente))
          continue
        }

        if (cobro.provider_transaction_id) {
          sumar((await confirmar(ref, cobro.provider_transaction_id)).resultado)
          continue
        }

        // El teléfono no volvió con el `id`: se busca por nuestra referencia.
        const consulta = await cliente.consultar(ref)
        if (consulta.tipo === 'respuesta' && consulta.transactionId) {
          if (consulta.statusCode === 2) {
            sumar(await asentar(ref, consulta.transactionId, consulta))
          } else {
            sumar((await confirmar(ref, consulta.transactionId)).resultado)
          }
          continue
        }
        const edad = ahora() - new Date(cobro.created_at).getTime()
        if (consulta.tipo === 'no_existe' && edad > CADUCA_SIN_PAGO_MS) {
          if (await deps.base.expireCardPayment(ref)) sumar('caducado')
          continue
        }
        sumar('esperando')
      } catch (error) {
        sumar('error')
        await alertar({ businessId: cobro.business_id, code: 'tarjeta_error_en_la_tarea',
          message: `La tarea de cobros falló: ${error instanceof Error ? error.message : String(error)}`,
          context: { referencia: cobro.client_transaction_id } })
      }
    }
    return cuenta
  }

  return { iniciar, confirmar, procesarPendientes }
}

export type PagosConTarjeta = ReturnType<typeof crearPagosConTarjeta>

// ── ¿Se ofrece la tarjeta en ESTE local, AHORA? ──────────────────────────────
//
// Las dos cosas a la vez: el superadmin la encendió para el local y el
// servidor cobra en ese MISMO modo. Un local de pruebas no ve la tarjeta con
// el servidor en producción, y uno real no la ve con el servidor en pruebas —
// que es lo que impide que PayPhone apruebe gratis el pedido de un cliente de
// verdad.
export function tarjetaDisponible(
  business: { card_mode?: string | null } | null | undefined,
  config: ConfiguracionPayphone | null = leerConfiguracionPayphone(),
): boolean {
  return Boolean(config && business?.card_mode && business.card_mode === config.modo)
}

/** Cómo se pinta la tarjeta en la lista de métodos de la tienda. */
export function metodoTarjeta(config: ConfiguracionPayphone) {
  return {
    code: 'tarjeta',
    label: 'Tarjeta de crédito o débito',
    help_text: config.modo === 'pruebas'
      ? 'MODO DE PRUEBA: no se cobra dinero real.'
      : 'Visa, Mastercard o Diners, en la página segura de PayPhone.',
    is_prepaid: true,
    requires_proof: false,
    // La tienda pinta una franja «PAGOS DE PRUEBA» con esto: en pruebas no se
    // cobra nada, y nadie puede creer que pagó de verdad.
    test_mode: config.modo === 'pruebas',
  }
}

// ── La instancia que usa el servidor de verdad ──────────────────────────────
//
// Perezosa: cargar este módulo no abre la base ni lee credenciales. Así las
// pruebas importan `crearPagosConTarjeta` con sus falsos sin tocar nada real.
let enVivo: PagosConTarjeta | null = null

export function pagosConTarjeta(): PagosConTarjeta {
  if (enVivo) return enVivo
  const db = require('../db') as typeof import('../db')
  const { recordError } = require('./error-log') as typeof import('./error-log')
  const { avisarAlDuenoDelPedido } = require('./owner-order-notice') as typeof import('./owner-order-notice')
  const { crearClientePayphone } = require('../integrations/payphone') as typeof import('../integrations/payphone')
  enVivo = crearPagosConTarjeta({
    configuracion: () => leerConfiguracionPayphone(),
    payphone: config => crearClientePayphone({ token: config.token, storeId: config.storeId }),
    base: db,
    urlPublica: () => String(process.env.BASE_URL || '').trim() || null,
    alertar: input => recordError({ ...input, businessId: input.businessId ?? null, category: 'pagos' }),
    avisarAlDueno: avisarAlDuenoDelPedido,
  })
  return enVivo
}
