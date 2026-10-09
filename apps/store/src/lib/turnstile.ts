// ═══════════════════════════════════════════════════════════════════════════
// ¿ES UNA PERSONA? El captcha invisible de Cloudflare (Turnstile, 2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Al pedir el código por correo, el servidor puede exigir una «ficha» que
// solo consigue una persona (`server/src/services/turnstile.ts`). Solo existe
// si el servidor lo dice (`GET /api/v1/auth/config`): apagado, este archivo no
// carga nada de fuera y la pantalla se ve como siempre.
//
// ⚠️ Invisible casi siempre: el widget se pinta con `interaction-only` y solo
// aparece (una casilla) cuando Cloudflare duda. Por eso tiene su sitio fijo en
// la pantalla aunque casi nunca se vea.
// ⚠️ Cada ficha vale UNA vez y 5 minutos: se pide en el momento de mandar
// («execute»), y «Mandarme otro código» pide otra.

const GUION = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** La misma acción que comprueba el servidor (`ACCION_DE_ENTRAR`). */
const ACCION = 'entrar-correo'

interface ApiDeTurnstile {
  render(contenedor: HTMLElement, opciones: Record<string, unknown>): string
  execute(id: string): void
  reset(id: string): void
  remove(id: string): void
}

declare global {
  interface Window { turnstile?: ApiDeTurnstile }
}

let cargando: Promise<ApiDeTurnstile> | null = null

function cargarGuion(): Promise<ApiDeTurnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  cargando ??= new Promise<ApiDeTurnstile>((listo, fallo) => {
    const guion = document.createElement('script')
    guion.src = GUION
    guion.async = true
    guion.onload = () => (window.turnstile ? listo(window.turnstile) : fallo(new Error('sin turnstile')))
    guion.onerror = () => {
      // Sin conexión, o la CSP lo frenó: el próximo intento lo vuelve a pedir.
      cargando = null
      guion.remove()
      fallo(new Error('No se pudo cargar'))
    }
    document.head.appendChild(guion)
  })
  return cargando
}

export interface FichaHumana {
  /** Una ficha nueva para mandar YA (cada una vale una vez). */
  obtener(): Promise<string>
  quitar(): void
}

export const NO_COMPROBADO = 'No pudimos comprobar que eres una persona. Vuelve a intentarlo.'

export async function prepararFichaHumana(contenedor: HTMLElement, claveDeSitio: string): Promise<FichaHumana> {
  const turnstile = await cargarGuion()
  let esperando: { listo: (ficha: string) => void; fallo: (error: Error) => void } | null = null
  let usada = false
  const id = turnstile.render(contenedor, {
    sitekey: claveDeSitio,
    action: ACCION,
    execution: 'execute',
    appearance: 'interaction-only',
    language: 'es',
    callback: (ficha: string) => {
      usada = true
      esperando?.listo(ficha)
      esperando = null
    },
    'error-callback': () => {
      esperando?.fallo(new Error(NO_COMPROBADO))
      esperando = null
      return true // ya se le dice a la persona: Cloudflare no reintenta solo
    },
    'expired-callback': () => { usada = true },
  })
  return {
    obtener: () => new Promise<string>((listo, fallo) => {
      esperando = { listo, fallo }
      if (usada) turnstile.reset(id)
      turnstile.execute(id)
    }),
    quitar: () => turnstile.remove(id),
  }
}
