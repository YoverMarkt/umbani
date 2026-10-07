import { leerConfiguracionCorreo, type ConfiguracionCorreo } from '../config/correo'
import { recordError } from './error-log'

// ═══════════════════════════════════════════════════════════════════════════
// MANDAR UN CORREO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Ver `config/correo.ts`. Nunca lanza: quien lo llama decide qué decirle a la
// persona según el resultado.

export type EnvioDeCorreo = 'enviado' | 'sin_proveedor' | 'fallo'

export interface Correo {
  para: string
  asunto: string
  texto: string
  html: string
}

const API_DE_RESEND = 'https://api.resend.com/emails'
/** Un proveedor que no contesta no puede dejar a la persona mirando la pantalla. */
const ESPERA_MAXIMA_MS = 10_000

export async function enviarCorreo(
  correo: Correo,
  dependencias: { config?: ConfiguracionCorreo | null; fetch?: typeof fetch } = {},
): Promise<EnvioDeCorreo> {
  const config = dependencias.config === undefined ? leerConfiguracionCorreo() : dependencias.config
  if (!config) return 'sin_proveedor'
  const pedir = dependencias.fetch || fetch

  let fallo: string
  try {
    const respuesta = await pedir(API_DE_RESEND, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.clave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.remitente,
        to: [correo.para],
        subject: correo.asunto,
        text: correo.texto,
        html: correo.html,
      }),
      signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
    })
    if (respuesta.ok) return 'enviado'
    fallo = `El proveedor de correo respondió ${respuesta.status}`
  } catch (error) {
    fallo = error instanceof Error ? error.message : String(error)
  }

  // Al registro que ve el superadmin: sin esto, «no me llega el código» no
  // dejaría ninguna pista. El registro tapa solo el correo de la persona.
  console.error(`❌ Correo: ${fallo}`)
  void recordError({ category: 'envio', code: 'correo_fallo', message: fallo })
  return 'fallo'
}
