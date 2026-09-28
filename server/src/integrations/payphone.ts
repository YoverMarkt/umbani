import axios from 'axios'

// ═══════════════════════════════════════════════════════════════════════════
// PAYPHONE: PREPARAR, CONFIRMAR, CONSULTAR Y REVERTIR UN COBRO CON TARJETA
// ═══════════════════════════════════════════════════════════════════════════
//
// Se usa el BOTÓN POR REDIRECCIÓN y no la «Cajita». La Cajita se configura en
// el JavaScript del navegador, con el token y el monto a la vista: cualquiera
// podía editar el monto, y con ese token se puede confirmar o revertir cobros.
// Aquí el cobro se prepara desde el servidor, con el monto de la base, y el
// cliente solo recibe una URL de PayPhone donde escribe su tarjeta. Los datos
// de la tarjeta NUNCA pasan por Umbani.
//
// ⚠️ Nada de esto decide el dinero: devuelve lo que PayPhone contestó, con su
// forma estrecha, y la base decide (`settle_card_payment`).
//
// ⚠️ NUNCA registra el token ni la respuesta cruda: la confirmación trae el
// correo, el teléfono y la cédula del titular de la tarjeta.

export const PAYPHONE_URL = 'https://pay.payphonetodoesposible.com'
const TIEMPO_LIMITE_MS = 15_000

/** Lo mínimo de axios que se usa: así las pruebas inyectan un falso. */
export interface HttpParaPayphone {
  post(url: string, body: unknown, config: { headers: Record<string, string>; timeout: number }): Promise<{ data: unknown }>
  get(url: string, config: { headers: Record<string, string>; timeout: number }): Promise<{ data: unknown }>
}

/** Lo que PayPhone dijo de un cobro. */
export interface RespuestaDeCobro {
  tipo: 'respuesta'
  /** 1 pendiente · 2 cancelado · 3 aprobado. */
  statusCode: number
  transactionId: string | null
  /** Centavos ENTEROS; `null` si PayPhone mandó algo que no es un entero. */
  capturedCents: number | null
  currency: string | null
  authorizationCode: string | null
  cardBrand: string | null
  lastDigits: string | null
  mensaje: string | null
}

/**
 * Un fallo al hablar con PayPhone.
 *
 * `definitivo` distingue «PayPhone dijo que no» (4xx: no existe, fuera de
 * plazo, datos inválidos) de «no se pudo preguntar» (red, tiempo, 5xx, 429).
 * Lo segundo se reintenta; lo primero no cambia por insistir.
 */
export interface FalloDePayphone {
  tipo: 'fallo'
  definitivo: boolean
  mensaje: string
  codigo: number | null
}

const texto = (valor: unknown): string | null => {
  if (valor === null || valor === undefined) return null
  const limpio = String(valor).trim()
  return limpio ? limpio : null
}

/** Lee la respuesta de `Confirm` o de la consulta por referencia. */
export function leerCobro(datos: unknown): RespuestaDeCobro | null {
  if (!datos || typeof datos !== 'object') return null
  const fila = datos as Record<string, unknown>
  const statusCode = Number(fila.statusCode)
  if (!Number.isInteger(statusCode)) return null
  const monto = typeof fila.amount === 'number' ? fila.amount : Number(fila.amount)
  return {
    tipo: 'respuesta',
    statusCode,
    transactionId: texto(fila.transactionId),
    capturedCents: Number.isInteger(monto) && monto >= 0 ? monto : null,
    currency: texto(fila.currency),
    authorizationCode: texto(fila.authorizationCode),
    cardBrand: texto(fila.cardBrand),
    lastDigits: texto(fila.lastDigits),
    mensaje: texto(fila.message) || texto(fila.transactionStatus),
  }
}

/** Convierte un error de axios en un fallo legible, sin datos del titular. */
export function leerFallo(error: unknown): FalloDePayphone {
  const respuesta = (error as { response?: { status?: number; data?: unknown } })?.response
  const estado = respuesta?.status ?? null
  const cuerpo = (respuesta?.data && typeof respuesta.data === 'object'
    ? respuesta.data
    : {}) as Record<string, unknown>
  const mensaje = texto(cuerpo.message)
    || (estado ? `PayPhone respondió ${estado}` : 'Sin respuesta de PayPhone')
  const codigo = Number.isInteger(Number(cuerpo.errorCode)) ? Number(cuerpo.errorCode) : null
  return {
    tipo: 'fallo',
    // 429 es «demasiadas consultas»: se reintenta como un fallo de red.
    definitivo: estado !== null && estado >= 400 && estado < 500 && estado !== 429,
    mensaje: mensaje.slice(0, 300),
    codigo,
  }
}

export interface PreparacionDeCobro {
  /** La página de PayPhone donde el cliente escribe su tarjeta. */
  urlTarjeta: string
  paymentId: string | null
}

export function crearClientePayphone(input: {
  token: string
  /** Opcional: sin él PayPhone usa la tienda por defecto del token. */
  storeId?: string | null
  http?: HttpParaPayphone
}) {
  const http: HttpParaPayphone = input.http || axios
  const cabeceras = {
    Authorization: `Bearer ${input.token}`,
    'Content-Type': 'application/json',
  }
  const opciones = { headers: cabeceras, timeout: TIEMPO_LIMITE_MS }

  return {
    /**
     * Prepara el cobro y devuelve la URL de pago.
     *
     * ⚠️ `amount` = `amountWithoutTax` = el total en centavos. PayPhone exige
     * que `amount` sea la suma exacta de sus partes; con una sola parte no hay
     * redondeo que pueda descuadrarlo. El desglose del IVA es una decisión
     * del contador antes de producción.
     */
    async preparar(cobro: {
      referencia: string
      centavos: number
      urlRespuesta: string
      urlCancelacion: string
      motivo: string
    }): Promise<PreparacionDeCobro | FalloDePayphone> {
      if (!Number.isInteger(cobro.centavos) || cobro.centavos <= 0) {
        return { tipo: 'fallo', definitivo: true, mensaje: 'Monto inválido', codigo: null }
      }
      try {
        const { data } = await http.post(`${PAYPHONE_URL}/api/button/Prepare`, {
          amount: cobro.centavos,
          amountWithoutTax: cobro.centavos,
          currency: 'USD',
          clientTransactionId: cobro.referencia,
          // Solo si hay uno: un `storeId` equivocado hace fallar el cobro
          // entero (error 100), uno ausente usa la tienda del token.
          ...(input.storeId ? { storeId: input.storeId } : {}),
          reference: cobro.motivo.slice(0, 100),
          responseUrl: cobro.urlRespuesta,
          cancellationUrl: cobro.urlCancelacion,
          timeZone: -5,
        }, opciones)
        const fila = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
        const urlTarjeta = texto(fila.payWithCard)
        // Solo una URL de PayPhone: jamás se manda al cliente a otro sitio
        // aunque la respuesta viniera alterada.
        if (!urlTarjeta || !urlTarjeta.startsWith(`${PAYPHONE_URL}/`)) {
          return { tipo: 'fallo', definitivo: false, mensaje: 'PayPhone no devolvió la página de pago', codigo: null }
        }
        return { urlTarjeta, paymentId: texto(fila.paymentId) }
      } catch (error) {
        return leerFallo(error)
      }
    },

    /** `Confirm`: lo que CAPTURA el dinero. Sin esto, PayPhone lo devuelve a los 5 min. */
    async confirmar(id: string, referencia: string): Promise<RespuestaDeCobro | FalloDePayphone> {
      const numero = Number(id)
      if (!Number.isSafeInteger(numero) || numero <= 0) {
        return { tipo: 'fallo', definitivo: true, mensaje: 'Id de PayPhone inválido', codigo: null }
      }
      try {
        const { data } = await http.post(`${PAYPHONE_URL}/api/button/V2/Confirm`, {
          id: numero,
          clientTxId: referencia,
        }, opciones)
        return leerCobro(data)
          || { tipo: 'fallo', definitivo: false, mensaje: 'Respuesta de PayPhone ilegible', codigo: null }
      } catch (error) {
        return leerFallo(error)
      }
    },

    /**
     * Busca un cobro por NUESTRA referencia. Es lo que permite confirmar
     * aunque el teléfono del cliente no vuelva nunca con el `id`.
     */
    async consultar(referencia: string): Promise<RespuestaDeCobro | FalloDePayphone | { tipo: 'no_existe' }> {
      try {
        const { data } = await http.get(
          `${PAYPHONE_URL}/api/Sale/client/${encodeURIComponent(referencia)}`,
          opciones,
        )
        // Puede venir una lista (varias transacciones con la misma referencia)
        // o una sola. Se toma la aprobada si la hay; si no, la última.
        const filas = Array.isArray(data) ? data : [data]
        const cobros = filas.map(leerCobro).filter((c): c is RespuestaDeCobro => c !== null)
        if (cobros.length === 0) return { tipo: 'no_existe' }
        return cobros.find(c => c.statusCode === 3) || cobros[cobros.length - 1]
      } catch (error) {
        const fallo = leerFallo(error)
        // «La transacción no existe» es una respuesta, no un fallo.
        if (fallo.definitivo && (fallo.codigo === 20 || /no existe/i.test(fallo.mensaje))) {
          return { tipo: 'no_existe' }
        }
        return fallo
      }
    },

    /** Revierte un cobro YA confirmado. PayPhone: mismo día y antes de las 20:00. */
    async revertir(id: string): Promise<{ tipo: 'revertido' } | FalloDePayphone> {
      const numero = Number(id)
      if (!Number.isSafeInteger(numero) || numero <= 0) {
        return { tipo: 'fallo', definitivo: true, mensaje: 'Id de PayPhone inválido', codigo: null }
      }
      try {
        const { data } = await http.post(`${PAYPHONE_URL}/api/Reverse`, { id: numero }, opciones)
        if (data === true || data === 'true') return { tipo: 'revertido' }
        return { tipo: 'fallo', definitivo: false, mensaje: 'PayPhone no confirmó la reversión', codigo: null }
      } catch (error) {
        return leerFallo(error)
      }
    },
  }
}

export type ClientePayphone = ReturnType<typeof crearClientePayphone>
