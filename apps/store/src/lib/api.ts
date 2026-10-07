import { clearToken, deviceId, readToken } from './session'
import type {
  Address, BankAccount, Catalog, Business, CartLine,
  CobroConTarjeta, Fulfillment, Me, OrderResult, PaymentMethod, StoreStatus,
  TrackedOrder,
} from './types'

/**
 * Error del servidor con la forma que la app necesita para reaccionar:
 * `reason` distingue "enlace de otro teléfono" de "enlace vencido", y eso
 * cambia por completo lo que se le dice al cliente.
 */
export class ApiError extends Error {
  readonly status: number
  readonly reason: string | null
  readonly code: string | null
  /** Hasta cuándo dura el bloqueo, si el rechazo es `bloqueado` y es temporal. */
  readonly until: string | null
  /** El bloqueo del dueño: no caduca, así que no promete plazo. */
  readonly permanent: boolean

  constructor(
    status: number,
    message: string,
    reason?: string,
    code?: string,
    extra?: { until?: string | null; permanent?: boolean },
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.reason = reason || null
    this.code = code || null
    this.until = extra?.until ?? null
    this.permanent = extra?.permanent === true
  }
}

/** ¿Este fallo significa que el enlace no sirve para este teléfono? */
export const isLinkProblem = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401

/**
 * ¿El local bloqueó a esta persona?
 *
 * ⚠️ Es 403 y NO 401, y la diferencia importa: con un 401 la app manda a pedir
 * otro enlace, y aquí el enlace está perfecto — pedir otro no arreglaría nada.
 * Tratarlos igual dejaba al cliente pidiendo enlaces en bucle.
 */
export const isBlocked = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 403 && error.reason === 'bloqueado'

/** Hasta cuándo dura el bloqueo. Nulo en el permanente: no hay plazo. */
export interface Bloqueo {
  until: string | null
  permanent: boolean
}

export const request = async <T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`/api/store${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-storefront-token': readToken(),
      'x-storefront-device': deviceId(),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })

  let payload: Record<string, unknown> = {}
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok) {
    // Un 401 quiere decir que el token guardado ya no vale para nada. Se borra
    // para que un reintento no lo vuelva a mandar.
    //
    // Salvo 'necesita_telefono': ahí el token está PERFECTO, solo falta que
    // esta persona demuestre que el número es suyo. Borrarlo dejaba al cliente
    // legítimo sin enlace justo cuando iba a confirmarlo — entraba el número
    // correcto y aun así acababa en «Necesitas tu propio enlace».
    //
    // ⚠️ Y salvo un enlace MUERTO (revocado o caducado, 2026-09-17). Ese token
    // es la prueba de que esta persona ya tuvo su enlace: borrarlo hacía que
    // la siguiente recarga llegara SIN enlace, el servidor la tratara como
    // visitante y la app dijera «Necesitas tu propio enlace» en vez de «Tu
    // enlace expiró». El enlace nuevo que llegue por el chat lo reemplaza.
    const soloFaltaElNumero = payload.reason === 'necesita_telefono'
    const enlaceMuerto = payload.reason === 'revocada' || payload.reason === 'caducada'
    if (response.status === 401 && !soloFaltaElNumero && !enlaceMuerto) clearToken()
    throw new ApiError(
      response.status,
      String(payload.error || 'No pudimos completar la operación'),
      typeof payload.reason === 'string' ? payload.reason : undefined,
      typeof payload.code === 'string' ? payload.code : undefined,
      {
        until: typeof payload.until === 'string' ? payload.until : null,
        permanent: payload.permanent === true,
      },
    )
  }
  return payload as T
}

/**
 * Portada. Es lo ÚNICO que responde sin enlace válido.
 *
 * ⚠️ Y lo único que responde a un BLOQUEADO. Trae `blocked` para que la app lo
 * sepa antes de montar la tienda: el 2026-08-29 alguien bloqueado abrió un
 * enlace viejo, recorrió la carta entera y llegó a crear un pedido. La portada
 * lleva el nombre y el logo del local y nada accionable, así que es
 * exactamente lo que hace falta para pintarle el aviso.
 */
export const getStore = (slug: string) => request<{
  business: Business
  status: StoreStatus
  canOrder: boolean
  blocked: Bloqueo | null
  /**
   * El enlace con el que se abrió ya no vale (revocado o caducado).
   *
   * Opcional porque un servidor anterior no lo manda, y ahí la app se comporta
   * como siempre: mira la carta y el 401 llega al pagar.
   */
  expired?: boolean
}>(`/${slug}`)

export const getCatalog = (slug: string) => request<Catalog>(`/${slug}/catalog`)

export const getMe = (slug: string) => request<Me>(`/${slug}/me`)

/** Mis pedidos en este negocio, para la pestaña de Cuenta. */
export const getOrders = (slug: string) => request<TrackedOrder[]>(`/${slug}/orders`)

/** El pedido del cliente con su línea de tiempo. Exige la sesión del enlace. */
export const getOrder = (slug: string, orderId: string) =>
  request<TrackedOrder>(`/${slug}/orders/${encodeURIComponent(orderId)}`)

export const getPaymentInfo = (slug: string) => request<BankAccount>(`/${slug}/payment-info`)

/**
 * Abre el cobro con tarjeta de un pedido YA creado: devuelve la página de
 * PayPhone. El monto no viaja: lo pone el servidor desde el pedido.
 */
export const startCardPayment = (slug: string, orderId: string) =>
  request<{ url: string }>(`/${slug}/orders/${encodeURIComponent(orderId)}/tarjeta`, { method: 'POST' })

/**
 * Lleva al cliente a la página de PayPhone diciendo DE DÓNDE viene.
 *
 * ⚠️ PayPhone solo acepta el pago si el navegador llega desde el dominio
 * registrado en su consola, y lo sabe por la cabecera `Referer`. La app entera
 * manda `Referrer-Policy: no-referrer` (la dirección de la tienda puede llevar
 * la sesión del cliente), así que con `location.assign` PayPhone recibía el
 * salto sin origen y respondía «NO AUTORIZADO» (primera prueba real,
 * 2026-09-27). Este enlace manda SOLO el origen —sin ruta ni parámetros—: lo
 * que PayPhone necesita comprobar, y nada que filtre la sesión.
 */
export const irAPayPhone = (url: string) => {
  const enlace = document.createElement('a')
  enlace.href = url
  enlace.referrerPolicy = 'origin'
  document.body.appendChild(enlace)
  enlace.click()
  enlace.remove()
}

/** ¿En qué quedó el cobro? La respuesta la decide el servidor, no la URL. */
export const getCardPayment = (slug: string, orderId: string) =>
  request<CobroConTarjeta>(`/${slug}/orders/${encodeURIComponent(orderId)}/tarjeta`)

export const createAddress = (slug: string, body: {
  label: string
  address: string
  reference?: string
  isDefault?: boolean
  /** El pin, si el cliente lo compartió. Va junto o no va: media coordenada
   *  no es medio pin, es un punto en el ecuador. */
  latitude?: number
  longitude?: number
  accuracy?: number | null
  /** También hace de etiqueta: «Casa», «Oficina»… Se elige, no se escribe. */
  buildingType?: string | null
}) => request<Address>(`/${slug}/addresses`, { method: 'POST', body })

/** Retira una dirección de la libreta. El servidor la marca inactiva. */
export const deleteAddress = (slug: string, addressId: string) =>
  request<{ ok: true }>(`/${slug}/addresses/${encodeURIComponent(addressId)}`, { method: 'DELETE' })

/**
 * Le pone el pin a una dirección ya guardada.
 *
 * Las direcciones de antes de esto no tienen coordenadas: sin esta puerta, el
 * botón solo serviría al estrenar dirección, y el cliente que ya tiene la suya
 * guardada es justo el que más pide.
 */
export const setAddressLocation = (slug: string, addressId: string, body: {
  latitude: number; longitude: number; accuracy?: number | null
}) => request<Address>(
  `/${slug}/addresses/${encodeURIComponent(addressId)}/location`,
  { method: 'PUT', body },
)

/**
 * Manda SOLO ids y cantidades. Ningún importe viaja desde el teléfono: el
 * total lo calcula la base contra su propio catálogo (regla inviolable #8).
 *
 * `idempotencyKey` la genera quien llama al abrir el checkout y la REPITE si
 * hay que reintentar. Sin ella, un doble toque en «Confirmar» —o un reintento
 * tras un corte de red— creaba dos comandas en la cocina y un cliente pagando
 * dos veces.
 */
export const createOrder = (slug: string, input: {
  lines: CartLine[]
  name?: string
  addressId?: string | null
  fulfillment: Fulfillment
  paymentMethod?: PaymentMethod | null
  idempotencyKey?: string
  /** Instrucciones del cliente para ESTE pedido: «llame al llegar». */
  deliveryNotes?: string | null
}) => request<OrderResult>(`/${slug}/orders`, {
  method: 'POST',
  body: {
    name: input.name,
    addressId: input.addressId,
    fulfillment: input.fulfillment,
    idempotencyKey: input.idempotencyKey,
    paymentMethod: input.paymentMethod || null,
    deliveryNotes: input.deliveryNotes || null,
    items: input.lines.map(linea => ({
      productId: linea.product.id,
      variantId: linea.variant?.id || null,
      extraIds: linea.extras.map(extra => extra.id),
      // Solo id y cantidad: el recargo lo recalcula la base contra su propio
      // catálogo, nunca se envía desde aquí (regla inviolable #8).
      options: linea.options.map(opcion => ({
        optionId: opcion.optionId,
        quantity: opcion.quantity,
      })),
      quantity: linea.quantity,
      note: linea.note || null,
    })),
  },
})

/**
 * Confirma el número de WhatsApp y ata la sesión a ESTE teléfono.
 *
 * Devuelve null si entró, o el texto a mostrar si no. No lanza: un número que
 * no coincide es lo esperado aquí —le pasa a todo el que reciba el enlace de
 * otra persona— y tratarlo como una excepción llenaría el registro de errores
 * de ruido.
 */
export async function confirmarTelefono(
  slug: string,
  telefono: string,
): Promise<string | null> {
  try {
    const respuesta = await fetch(`/api/store/${encodeURIComponent(slug)}/session/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-storefront-token': readToken(),
        'x-storefront-device': deviceId(),
      },
      body: JSON.stringify({ phone: telefono }),
    })
    if (respuesta.ok) return null
    const cuerpo = await respuesta.json().catch(() => ({}))
    if (respuesta.status === 429) {
      return 'Demasiados intentos. Espera un minuto y vuelve a probar.'
    }
    return String(
      (cuerpo as { error?: unknown }).error
      || 'Ese número no coincide con este enlace.',
    )
  } catch {
    return 'No pudimos comprobarlo. Revisa tu conexión e inténtalo otra vez.'
  }
}

// ⚠️ Aquí vivía `uploadPaymentProof`, la subida del comprobante desde la app.
// Se retiró el 2026-08-12: el comprobante se manda por WhatsApp y la foto se
// adjunta sola al pedido (`services/payment-proof-inbox.ts`). Era la ÚNICA
// petición multipart de esta app.
//
// La ruta `POST /api/store/:slug/orders/:id/proof` sigue en el servidor,
// protegida por sesión, con su límite de peticiones y sus pruebas. No se borró:
// funciona, no estorba y es la puerta que usaría el Marketplace o una vuelta
// atrás. Lo que ya no hay es quien la llame desde aquí.
