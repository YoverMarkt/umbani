import crypto from 'node:crypto'

// ═══════════════════════════════════════════════════════════════════════════
// CÓDIGOS DE UN SOLO USO (TOTP, RFC 6238) — EL SEGUNDO PASO DEL SUPERADMIN
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño lo pidió el 2026-09-29: hasta hoy el superadmin —el que ve el
// dinero de todos, enciende la tarjeta y marca liquidaciones como pagadas—
// entraba solo con correo y contraseña. Eligió una APP de códigos (Google
// Authenticator o similar) y no un código por WhatsApp: no cuesta mensajes,
// funciona sin datos en el móvil y no depende del saldo de YCloud, que es
// justo lo que se acaba el día que hay que entrar a arreglar algo.
//
// ⚠️ Escrito con el `crypto` de Node y no con una librería: el stack está
// cerrado (CLAUDE.md §2), y el estándar cabe en cuarenta líneas que las
// pruebas comprueban contra los vectores oficiales del RFC 6238.

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
/** Cada código vale 30 segundos, como en todas las apps de códigos. */
export const SEGUNDOS_POR_PASO = 30
const DIGITOS = 6

export function base32(bytes: Buffer): string {
  let bits = 0
  let valor = 0
  let salida = ''
  for (const byte of bytes) {
    valor = (valor << 8) | byte
    bits += 8
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31]
  return salida
}

/** La clave vuelve a bytes. Espacios y minúsculas valen: es como se copia a mano. */
export function desdeBase32(texto: string): Buffer {
  const limpio = String(texto || '').toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let valor = 0
  const bytes: number[] = []
  for (const letra of limpio) {
    const indice = ALFABETO.indexOf(letra)
    if (indice < 0) throw new Error('La clave no es base32')
    valor = (valor << 5) | indice
    bits += 5
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** Una clave nueva: 160 bits, lo que recomienda el RFC para SHA-1. */
export const nuevaClave = (): string => base32(crypto.randomBytes(20))

/** El paso de 30 segundos en que cae un instante. */
export const pasoDe = (ahoraMs: number): number => Math.floor(ahoraMs / 1000 / SEGUNDOS_POR_PASO)

/** El código de un paso concreto (HOTP, RFC 4226). */
export function codigoDelPaso(clave: Buffer, paso: number, digitos = DIGITOS): string {
  const contador = Buffer.alloc(8)
  contador.writeBigUInt64BE(BigInt(paso))
  const huella = crypto.createHmac('sha1', clave).update(contador).digest()
  const desde = huella[huella.length - 1] & 0x0f
  const numero = ((huella[desde] & 0x7f) << 24)
    | (huella[desde + 1] << 16)
    | (huella[desde + 2] << 8)
    | huella[desde + 3]
  return String(numero % 10 ** digitos).padStart(digitos, '0')
}

const iguales = (a: string, b: string): boolean => (
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
)

/**
 * ¿Vale este código ahora? Devuelve el PASO que casó, o `null`.
 *
 * · Se acepta el paso de antes y el de después: el reloj del móvil y el del
 *   servidor nunca están clavados, y 30 s de desfase es lo normal.
 * · ⚠️ Nunca un paso igual o anterior a `ultimoUsado`: un código ya usado no
 *   vuelve a abrir la puerta, aunque siga dentro de su minuto y medio. Quien
 *   lo vio por encima del hombro no puede entrar detrás del dueño.
 */
export function verificarCodigo(
  claveBase32: string,
  codigo: string,
  ahoraMs: number,
  ultimoUsado = -1,
): number | null {
  const escrito = String(codigo || '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(escrito)) return null
  let clave: Buffer
  try {
    clave = desdeBase32(claveBase32)
  } catch {
    return null
  }
  if (!clave.length) return null
  const actual = pasoDe(ahoraMs)
  for (const paso of [actual - 1, actual, actual + 1]) {
    if (paso <= ultimoUsado) continue
    if (iguales(codigoDelPaso(clave, paso), escrito)) return paso
  }
  return null
}

/**
 * El enlace `otpauth://` que entienden todas las apps de códigos. En el móvil
 * abre la app directamente; en el ordenador se escribe la clave a mano.
 */
export function enlaceDeConfiguracion(claveBase32: string, cuenta: string, emisor = 'Umbani'): string {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`)
  const parametros = new URLSearchParams({
    secret: claveBase32,
    issuer: emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(SEGUNDOS_POR_PASO),
  })
  return `otpauth://totp/${etiqueta}?${parametros.toString()}`
}
