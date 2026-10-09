import crypto from 'node:crypto'

// Sesiones de la mini app del negocio.
//
// La tienda NO tiene registro ni contraseña: el cliente ya se identificó al
// escribir por WhatsApp, y el enlace que le manda el bot ES su sesión.
//
// Tres decisiones que sostienen la seguridad de todo esto:
//
//  1. En la base se guarda el HASH del token, nunca el token. Quien lea la base
//     no puede entrar en la tienda de nadie.
//  2. La sesión se ata al PRIMER dispositivo que la abre. Un enlace reenviado no
//     sirve para comprar: quien lo reciba verá una pantalla que le invita a
//     escribir al negocio para pedir el suyo.
//  3. Caduca en horas, no en días. Un enlace viejo no abre nada.
//
// Todo aquí es cálculo puro. La persistencia vive en el repositorio.

/**
 * El enlace NO caduca.
 *
 * Caducaba en 6 h, y la idea era buena: un enlace viejo no abre nada. Pero en
 * la práctica el cliente guardaba el enlace, volvía dos días después y se
 * encontraba una pantalla de error — y el negocio perdía el pedido. Peor aún,
 * el token vivía en `sessionStorage`, así que cerrar el webview de WhatsApp ya
 * lo perdía: las 6 h ni siquiera eran el límite real.
 *
 * Lo que protege el enlace ahora no es el reloj, es el TELÉFONO: para usarlo
 * hay que confirmar el número de WhatsApp al que se emitió. Un enlace
 * reenviado no sirve por muy fresco que esté, y el propio sirve para siempre.
 */
export const SESSION_NEVER_EXPIRES = null

/**
 * Bytes del token. 16 bytes = 128 bits, la misma entropía que un UUID v4: no
 * se adivina ni probando desde ahora hasta que se apague el sol.
 *
 * Eran 32 y se bajó a 16 por una razón muy concreta: el enlace viaja en un
 * mensaje de WhatsApp, y 43 caracteres de token frente a 22 es la diferencia
 * entre un enlace que se lee y un muro de letras que da desconfianza.
 */
const TOKEN_BYTES = 16

export type SessionRejection =
  | 'no_existe'
  | 'caducada'
  | 'revocada'
  | 'otro_dispositivo'
  | 'otro_negocio'
  /** Hay que confirmar el número de WhatsApp antes de entrar. */
  | 'necesita_telefono'
  /**
   * El local bloqueó a esta persona.
   *
   * ⚠️ NO es un problema del enlace: el enlace es suyo y es válido. Por eso se
   * responde 403 y no 401 —no hay credencial que arreglar— y por eso la app
   * pinta una pantalla distinta: mandarla a «pide tu enlace» la dejaría dando
   * vueltas pidiendo enlaces que tampoco funcionarían.
   */
  | 'bloqueado'

export interface StorefrontSessionRecord {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  /** Nulo = no caduca. */
  expires_at: string | null
  revoked_at: string | null
  verified_at?: string | null
}

export interface SessionCheck {
  ok: boolean
  reason?: SessionRejection
  session?: StorefrontSessionRecord
  /** true si esta apertura reclama la sesión para este dispositivo. */
  claims?: boolean
}

const sha256 = (value: string): string => crypto
  .createHash('sha256')
  .update(String(value))
  .digest('hex')

/** Token nuevo: el texto va al enlace, el hash a la base. */
export function createSessionToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  return { token, tokenHash: sha256(token) }
}

export const hashToken = (token: string): string => sha256(token)

/**
 * Huella del dispositivo. No pretende ser infalible —un fingerprint nunca lo
 * es— sino distinguir "el móvil del cliente" de "el móvil de su amigo", que es
 * lo único que hace falta para que un enlace reenviado no compre.
 */
export function deviceFingerprint(input: {
  userAgent?: string | null
  acceptLanguage?: string | null
  clientId?: string | null
}): string {
  return sha256([
    String(input.clientId || '').trim(),
    String(input.userAgent || '').trim(),
    String(input.acceptLanguage || '').trim(),
  ].join('|'))
}

/**
 * ¿El número que escribe quien abre el enlace es al que se emitió?
 *
 * Se comparan solo los dígitos: la gente escribe su número con espacios,
 * guiones, con y sin el código de país. Exigir el formato exacto convertiría
 * una comprobación de seguridad en una trampa de usabilidad, y el cliente
 * legítimo acabaría fuera.
 *
 * Se acepta que uno de los dos venga sin código de país comparando por el
 * final: `0999111222` y `593999111222` son la misma persona en Ecuador.
 */
export function phoneMatchesSession(
  sessionPhone: string | null | undefined,
  entered: string | null | undefined,
): boolean {
  const limpio = (valor: string | null | undefined) => String(valor || '').replace(/\D/g, '')
  const esperado = limpio(sessionPhone)
  const recibido = limpio(entered)
  // Menos de 8 dígitos no es un teléfono: se rechaza en vez de dejar que un
  // '1' coincida por el final con cualquier cosa.
  if (esperado.length < 8 || recibido.length < 8) return false
  if (esperado === recibido) return true
  const corto = esperado.length < recibido.length ? esperado : recibido
  const largo = esperado.length < recibido.length ? recibido : esperado
  // El 0 inicial de los móviles se pierde al anteponer el código de país.
  const sinCero = corto.replace(/^0+/, '')
  return sinCero.length >= 8 && largo.endsWith(sinCero)
}

/**
 * ¿Puede este dispositivo usar esta sesión?
 *
 * La primera apertura la reclama; las siguientes deben venir del mismo sitio.
 */
export function checkSession(input: {
  session: StorefrontSessionRecord | null
  deviceHash: string
  /** Negocio de la URL. Se exige aquí para que ningún endpoint pueda olvidarlo. */
  expectedBusinessId?: string | null
  now?: Date
}): SessionCheck {
  const { session, deviceHash } = input
  const now = input.now ?? new Date()

  if (!session) return { ok: false, reason: 'no_existe' }

  // Un token es válido para UN negocio. Sin esta comprobación, una sesión de la
  // pizzería abriría la tienda del hostal con solo cambiar el slug de la URL.
  if (input.expectedBusinessId && session.business_id !== input.expectedBusinessId) {
    return { ok: false, reason: 'otro_negocio' }
  }

  if (session.revoked_at) return { ok: false, reason: 'revocada' }
  // `expires_at` nulo = no caduca. Es el caso normal desde el 2026-08-02; las
  // sesiones viejas con fecha siguen respetándola hasta que se limpien.
  if (session.expires_at
    && new Date(session.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'caducada' }
  }

  // Este dispositivo ya demostró el número: pasa.
  if (session.device_hash && session.device_hash === deviceHash) {
    return { ok: true, session, claims: false }
  }

  // Y si no, hay que confirmar el número. Vale tanto para la sesión que nadie
  // ha abierto como para la que abrió otro.
  //
  // Antes, la primera apertura se la quedaba sin preguntar nada. Ese era el
  // agujero: quien reenviaba el enlace ANTES de abrirlo se lo regalaba al
  // primero que hiciera clic, y el cliente legítimo se encontraba «ya lo está
  // usando otra persona» sobre un enlace suyo.
  return { ok: false, reason: 'necesita_telefono', session }
}

/**
 * Qué contarle a quien no puede entrar. Nunca revela datos del dueño.
 *
 * Desde el 2026-10-09 manda de vuelta a la APP, no a WhatsApp: Umbani es solo
 * app y la sesión de tienda la pide la app (`/api/v1/locales/:slug/sesion`).
 */
export function rejectionMessage(reason: SessionRejection): string {
  switch (reason) {
    // Deliberadamente igual que 'no_existe': quien prueba un token de otro
    // negocio no debe averiguar que existe y pertenece a otro sitio.
    case 'otro_negocio':
      return 'Este acceso a la tienda no es válido. Vuelve a Umbani para hacer tu pedido.'
    case 'otro_dispositivo':
      return 'Este acceso a la tienda es de otro teléfono. Vuelve a Umbani y entra con tu cuenta.'
    // No es un rechazo: es un paso más. El texto lo pinta la app.
    case 'necesita_telefono':
      return 'Entra a esta tienda desde la app de Umbani.'
    case 'caducada':
      return 'Este acceso ya venció. Vuelve a Umbani para entrar otra vez.'
    case 'revocada':
      return 'Este acceso ya no está disponible. Vuelve a Umbani para continuar.'
    case 'bloqueado':
      return 'Ahora mismo no puedes hacer pedidos aquí.'
    default:
      return 'Este acceso a la tienda no es válido. Vuelve a Umbani para hacer tu pedido.'
  }
}
