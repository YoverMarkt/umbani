// ═══════════════════════════════════════════════════════════════════════════
// EL CORREO QUE MANDA UMBANI (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Hoy un solo correo: el código para entrar a las apps. Lo manda Resend por su
// API HTTP, sin librería: es una petición.
//
// ⚠️ SOLO VARIABLES DE ENTORNO (Railway), como las de PayPhone, nunca el
// panel: quien controla el remitente puede mandar correos «de Umbani». Sin las
// dos variables no se manda nada y la puerta de correo lo dice
// (`services/entrar-con-correo.ts`).
//
//   RESEND_API_KEY    la clave de Resend
//   CORREO_REMITENTE  quien firma, p. ej. «Umbani <hola@umbani.ec>». Su
//                     dominio tiene que estar verificado en Resend.

export interface ConfiguracionCorreo {
  clave: string
  remitente: string
}

export const VARIABLES_CORREO = {
  clave: 'RESEND_API_KEY',
  remitente: 'CORREO_REMITENTE',
} as const

export function leerConfiguracionCorreo(
  env: Record<string, string | undefined> = process.env,
): ConfiguracionCorreo | null {
  const clave = String(env[VARIABLES_CORREO.clave] || '').trim()
  const remitente = String(env[VARIABLES_CORREO.remitente] || '').trim()
  return clave && remitente ? { clave, remitente } : null
}
