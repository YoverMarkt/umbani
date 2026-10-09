import { esClaveDePruebasDeTurnstile } from '../config/turnstile'

// ═══════════════════════════════════════════════════════════════════════════
// ¿ES UNA PERSONA? La ficha de Turnstile, comprobada en Cloudflare
// ═══════════════════════════════════════════════════════════════════════════
//
// El widget de la app le da a la persona una ficha; aquí se canjea UNA vez en
// Cloudflare (`siteverify`). Ver `config/turnstile.ts`.
//
// Tres respuestas, porque no son lo mismo:
//   · `humano`     — adelante.
//   · `rechazado`  — sin ficha, ficha falsa, vencida (5 min), ya usada o de
//                    otro widget. La app pide otra y la persona reintenta.
//   · `caido`      — Cloudflare no contestó. ⚠️ Se FALLA CERRADO: no se manda
//                    el código. Dejar pasar cuando la comprobación no responde
//                    convertiría cualquier caída en la puerta abierta que esto
//                    existe para cerrar; y si Cloudflare está caído, con el
//                    dominio detrás de Cloudflare tampoco llegaría nadie.

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** La acción con la que la app pinta el widget: una ficha de otra acción no vale aquí. */
export const ACCION_DE_ENTRAR = 'entrar-correo'
/** Lo más que mide una ficha según Cloudflare. */
const LARGO_MAXIMO = 2048

export type VeredictoHumano = 'humano' | 'rechazado' | 'caido'

export interface DependenciasDeTurnstile {
  secreto: string
  pedir?: typeof fetch
  limiteMs?: number
}

export async function comprobarFichaHumana(
  ficha: unknown,
  ip: string | undefined,
  { secreto, pedir = fetch, limiteMs = 5_000 }: DependenciasDeTurnstile,
): Promise<VeredictoHumano> {
  if (typeof ficha !== 'string' || !ficha.trim() || ficha.length > LARGO_MAXIMO) return 'rechazado'

  let respuesta: Response
  try {
    respuesta = await pedir(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secreto, response: ficha, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(limiteMs),
    })
  } catch {
    return 'caido'
  }
  if (!respuesta.ok) return 'caido'

  let datos: { success?: unknown; action?: unknown; 'error-codes'?: unknown }
  try {
    datos = await respuesta.json() as typeof datos
  } catch {
    return 'caido'
  }
  if (datos.success !== true) {
    const codigos = Array.isArray(datos['error-codes']) ? datos['error-codes'] : []
    // El fallo es de Cloudflare, no de la ficha.
    return codigos.includes('internal-error') ? 'caido' : 'rechazado'
  }
  // ⚠️ Las claves de PRUEBA devuelven la acción vacía: con ellas no se mira
  // (solo existen en el staging; `environment.ts` las prohíbe en producción).
  if (!esClaveDePruebasDeTurnstile(secreto) && datos.action !== ACCION_DE_ENTRAR) return 'rechazado'
  return 'humano'
}
