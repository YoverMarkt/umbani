import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { Correo, EnvioDeCorreo } from './correo'

// ═══════════════════════════════════════════════════════════════════════════
// ENTRAR A LAS APPS CON EL CORREO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño: las apps dejan de entrar por WhatsApp. La app pide un
// código, llega al correo, y quien lo escribe prueba que el correo es suyo.
// Ver `migration-2026-10-06-entrar-con-correo.sql`.
//
// Las defensas, cada una contra algo concreto:
//  · 6 dígitos al azar criptográfico, 10 minutos, un solo uso.
//  · Se guarda su HUELLA con el secreto del servidor: con la base filtrada no
//    se entra, ni se pueden probar fuera de línea el millón de combinaciones.
//  · 5 intentos por código, y solo vale el ÚLTIMO pedido: quien adivina no
//    puede repartir intentos entre varios códigos vivos.
//  · 5 códigos por hora y correo: sin tope, este servidor serviría para
//    llenarle el buzón a cualquiera.
//  · Un tope GLOBAL por hora (2026-10-08, `CODIGOS_POR_HORA_EN_TOTAL`): los
//    de arriba frenan a uno que insiste, no a mil bots que piden UN código
//    cada uno para correos inventados. Esos correos rebotan, y un remitente
//    con muchos rebotes acaba suspendido por el proveedor: nadie más podría
//    entrar. Al llenarse queda en el registro de errores.
//  · La respuesta es la misma exista o no la cuenta: nadie puede averiguar
//    quién usa Umbani preguntando.
//
// ⚠️ SOLO EN STAGING el código vuelve en la respuesta, para probar sin
// proveedor de correo (las credenciales llegan al final). `esStaging` es
// fiable: un servidor de staging no arranca contra una base sin su marca
// (`config/identidad-de-la-base.ts`). En producción, sin proveedor, la puerta
// dice que no está disponible.

export const VIGENCIA_DEL_CODIGO_DE_CORREO_MS = 10 * 60 * 1000
export const INTENTOS_POR_CODIGO = 5
export const CODIGOS_POR_HORA = 5
/**
 * Para TODA la plataforma. Holgado para el día a día (una cuenta pide código
 * al entrar en un teléfono nuevo, y la sesión dura 30 días); se sube con
 * `CORREO_CODIGOS_POR_HORA_EN_TOTAL` antes de una campaña.
 */
export const CODIGOS_POR_HORA_EN_TOTAL = 120
export const CODIGO_DE_CORREO_VALIDO = /^\d{6}$/

export const generarCodigoDeCorreo = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

/** La huella que se guarda. Sin el secreto del servidor no se puede rehacer. */
export const huellaDelCodigo = (correo: string, codigo: string, secreto: string): string =>
  createHmac('sha256', secreto).update(`${correo}:${codigo}`).digest('hex')

/** Comparar sin delatar con el tiempo cuántos caracteres coinciden. */
const mismaHuella = (a: string, b: string): boolean => (
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
)

export function mensajeDelCodigo(para: string, codigo: string): Correo {
  return {
    para,
    // El código delante: se lee en la notificación sin abrir el correo.
    asunto: `${codigo} es tu código de Umbani`,
    texto: `Tu código para entrar a Umbani es ${codigo}.\n\n`
      + 'Vale 10 minutos. Si no lo pediste tú, ignora este correo: sin el código nadie puede entrar.',
    html: '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0B0B0C;max-width:420px">'
      + '<p style="font-size:15px">Tu código para entrar a Umbani es:</p>'
      + `<p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:16px 0">${codigo}</p>`
      + '<p style="font-size:13px;color:#6b6b70">Vale 10 minutos. Si no lo pediste tú, ignora este correo: '
      + 'sin el código nadie puede entrar.</p></div>',
  }
}

export interface CodigoVigente {
  id: string
  code_hash: string
  attempts: number
}

export interface DependenciasDelCorreo {
  hayProveedor: () => boolean
  esStaging: () => boolean
  secreto: () => string
  contarCodigos: (correo: string, desde: Date) => Promise<number>
  guardarCodigo: (correo: string, huella: string, expira: Date) => Promise<void>
  enviar: (correo: Correo) => Promise<EnvioDeCorreo>
  codigoVigente: (correo: string) => Promise<CodigoVigente | null>
  /** Gasta un intento si nadie lo gastó a la vez; false si otro llegó antes. */
  gastarIntento: (id: string, intentosAntes: number) => Promise<boolean>
  marcarUsado: (id: string) => Promise<boolean>
  /** El tope global: ¿cabe otro código en toda la plataforma? Si cabe, ya cuenta. */
  cabeOtroCodigo: () => boolean
  ahora?: () => number
}

export type ResultadoDePedirCodigo =
  | { estado: 'enviado'; expiraEn: string }
  | { estado: 'pruebas'; expiraEn: string; codigo: string }
  | { estado: 'demasiados' | 'saturado' | 'no_disponible' | 'fallo' }

export async function pedirCodigoPorCorreo(correo: string, d: DependenciasDelCorreo): Promise<ResultadoDePedirCodigo> {
  const pruebas = !d.hayProveedor() && d.esStaging()
  // Sin proveedor y fuera del staging no se guarda nada: un código que nunca
  // llegará solo serviría para llenar la tabla.
  if (!d.hayProveedor() && !pruebas) return { estado: 'no_disponible' }

  const ahora = d.ahora?.() ?? Date.now()
  if (await d.contarCodigos(correo, new Date(ahora - 60 * 60 * 1000)) >= CODIGOS_POR_HORA) {
    return { estado: 'demasiados' }
  }
  // DESPUÉS del tope por correo: quien ya agotó los suyos no gasta cupo ajeno.
  if (!d.cabeOtroCodigo()) return { estado: 'saturado' }
  const codigo = generarCodigoDeCorreo()
  const expira = new Date(ahora + VIGENCIA_DEL_CODIGO_DE_CORREO_MS)
  await d.guardarCodigo(correo, huellaDelCodigo(correo, codigo, d.secreto()), expira)

  if (pruebas) return { estado: 'pruebas', expiraEn: expira.toISOString(), codigo }
  return await d.enviar(mensajeDelCodigo(correo, codigo)) === 'enviado'
    ? { estado: 'enviado', expiraEn: expira.toISOString() }
    : { estado: 'fallo' }
}

export type ResultadoDelCanje = 'ok' | 'incorrecto' | 'vencido'

export async function canjearCodigoDeCorreo(correo: string, codigo: string, d: DependenciasDelCorreo): Promise<ResultadoDelCanje> {
  if (!CODIGO_DE_CORREO_VALIDO.test(codigo)) return 'incorrecto'
  const vigente = await d.codigoVigente(correo)
  if (!vigente || vigente.attempts >= INTENTOS_POR_CODIGO) return 'vencido'
  // El intento se gasta ANTES de comparar: así ni cien intentos a la vez
  // pasan del tope, porque cada uno tiene que ganarse su intento.
  if (!await d.gastarIntento(vigente.id, vigente.attempts)) return 'incorrecto'
  if (!mismaHuella(vigente.code_hash, huellaDelCodigo(correo, codigo, d.secreto()))) {
    return vigente.attempts + 1 >= INTENTOS_POR_CODIGO ? 'vencido' : 'incorrecto'
  }
  return await d.marcarUsado(vigente.id) ? 'ok' : 'vencido'
}
