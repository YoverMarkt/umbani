import crypto from 'node:crypto'
import { OPCION_ANTERIOR } from './marketplace-menu'

// ═══════════════════════════════════════════════════════════════════════════
// SOLO VALE EL ÚLTIMO MENSAJE, Y NO SE REPITE LA MISMA RESPUESTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo encontró el dueño en producción el 2026-09-26, probando el número de
// Umbani:
//
//   · Estando en «Panaderías» tocó «🛒 Minimarkets» en una lista VIEJA. Cada
//     opción viajaba solo con su número de fila, y el número se aplicaba a lo
//     que había en pantalla AHORA: «3» no era ninguna opción de Panaderías, así
//     que el bot BUSCÓ «3». Después «🥤 Jugos y batidos», también vieja, cayó
//     en Monster Pizza y le entregó la carta de otro local.
//   · Tres fotos seguidas, tres respuestas idénticas. Veinte, veinte — y desde
//     el 1 de octubre cada respuesta se paga.
//
// La referencia fue el chat de Luka (pagos de servicios, Bolivia): solo se
// puede usar el último mensaje, y a un toque viejo se le contesta una vez.

/** El id de una opción con la marca de su lista: «k3f9a.2». */
export const OPCION_CON_MARCA = /^([a-z0-9]{4,10})\.(\d{1,2})$/

/** Cuánto dura el «ya te lo dije»: la misma respuesta no sale dos veces aquí dentro. */
export const VENTANA_ANTI_ECO_MS = 60_000

/** Una marca nueva: cinco caracteres hexadecimales, como admite la columna. */
export const nuevaMarca = (): string => crypto.randomBytes(3).toString('hex').slice(0, 5)

/**
 * Qué quiso decir el cliente al tocar una opción.
 *
 * · Con la marca de la última lista → el número de la fila, como siempre.
 * · Con OTRA marca → `OPCION_ANTERIOR`: no se ejecuta nada, se avisa y se
 *   repinta lo de ahora (lo hace el menú, que lo trata como un adjunto).
 * · Sin marca guardada → se acepta. Es la conversación de antes de esto, o una
 *   marca que no se pudo guardar: falla ABIERTO, como hasta hoy.
 * · Texto escrito, o una opción sin marca → pasa tal cual.
 */
export function leerToque(
  texto: string,
  marcaVigente: string | null | undefined,
): { texto: string; vieja: boolean } {
  const toque = OPCION_CON_MARCA.exec(String(texto || '').trim())
  if (!toque) return { texto, vieja: false }
  if (!marcaVigente || toque[1] === marcaVigente) return { texto: toque[2], vieja: false }
  return { texto: OPCION_ANTERIOR, vieja: true }
}

// ── Tocar opciones viejas tiene consecuencia (2026-09-28) ──────────────────
//
// Lo pidió el dueño tras probarlo: tocó una lista vieja, recibió el aviso, y
// volvió a tocar OTRA vieja. El anti-eco calló el segundo aviso —idéntico al
// de hacía segundos— y el «escribiendo…» se quedó colgado sin respuesta.
//
// La regla de Luka se queda SIEMPRE. Lo que cambia es que saltársela cuesta:
// la primera vez, una advertencia; la segunda, 5 minutos sin menú.

/** Cuánto dura la pausa del menú tras el segundo toque viejo. */
export const PAUSA_POR_OPCIONES_VIEJAS_MS = 5 * 60_000

/**
 * Cuánto vale la advertencia. Pasado esto, el siguiente toque viejo vuelve a
 * ser solo una advertencia: quien se equivocó a mediodía no puede quedarse
 * pausado por un despiste de la noche.
 */
export const VIGENCIA_DE_LA_ADVERTENCIA_MS = 30 * 60_000

const instante = (valor: string | null | undefined): number | null => {
  if (!valor) return null
  const t = Date.parse(valor)
  return Number.isNaN(t) ? null : t
}

/** ¿Está el menú de este cliente en pausa ahora mismo? */
export const menuEnPausa = (
  pausaHasta: string | null | undefined,
  ahora: number = Date.now(),
): boolean => {
  const fin = instante(pausaHasta)
  return fin !== null && ahora < fin
}

/** Qué le toca a este toque viejo: la advertencia, o la pausa. */
export const queHacerConElToqueViejo = (
  advertidoEn: string | null | undefined,
  ahora: number = Date.now(),
): 'advertir' | 'pausar' => {
  const aviso = instante(advertidoEn)
  return aviso !== null && ahora - aviso < VIGENCIA_DE_LA_ADVERTENCIA_MS ? 'pausar' : 'advertir'
}

type Opcion = string | { title: string; description?: string }

/**
 * La huella de una respuesta: el texto y sus opciones, SIN la marca. Dos
 * respuestas iguales tienen la misma huella aunque cada una lleve su marca.
 */
export const huellaDeRespuesta = (reply: string, options: Opcion[] = []): string => (
  crypto
    .createHash('sha256')
    .update(JSON.stringify([reply, options.map(o => (typeof o === 'string' ? o : [o.title, o.description ?? '']))]))
    .digest('hex')
    .slice(0, 32)
)

interface Enviador {
  send(reply: string, options: Opcion[], marca?: string | null): Promise<void>
  sendLink?(mensaje: { body: string; url: string; label: string; footer?: string | null }): Promise<boolean>
  database: {
    marcarUltimaLista?(customerId: string, marca: string): Promise<boolean>
    anotarUltimaRespuesta?(customerId: string, huella: string): Promise<void>
  }
  logger?: { log(...args: unknown[]): void }
}

/**
 * Los envíos de UN turno, envueltos: con la marca en cada lista y sin repetir
 * la misma respuesta.
 *
 * `ultima` es lo que dejó el turno anterior —la conversación se lee al
 * empezar—. La cola atiende a cada cliente de uno en uno (FIFO por
 * conversación), así que el turno siguiente siempre ve lo que este anotó.
 *
 * ⚠️ La marca se guarda ANTES de mandar la lista, y la huella DESPUÉS de
 * mandarla. Al revés, una marca sin guardar haría que el toque del cliente en
 * su último mensaje pareciera viejo, y una huella anotada de un envío que
 * falló callaría el reintento para siempre.
 */
export function enviosDelTurno<D extends Enviador>(
  deps: D,
  customerId: string,
  ultima: { huella?: string | null; at?: string | null },
  ahora: () => number = Date.now,
): Pick<D, 'send' | 'sendLink'> {
  let previa = {
    huella: ultima.huella ?? null,
    at: ultima.at ? Date.parse(ultima.at) : null,
  }
  const repetida = (huella: string): boolean => (
    previa.huella === huella && previa.at !== null && ahora() - previa.at < VENTANA_ANTI_ECO_MS
  )
  const anotar = async (huella: string): Promise<void> => {
    previa = { huella, at: ahora() }
    // Falla ABIERTO: sin la huella, lo peor es repetir una respuesta.
    await deps.database.anotarUltimaRespuesta?.(customerId, huella)?.catch(() => undefined)
  }

  const send = async (reply: string, options: Opcion[] = []): Promise<void> => {
    const huella = huellaDeRespuesta(reply, options)
    if (repetida(huella)) {
      deps.logger?.log('🔇 [marketplace] la misma respuesta salió hace menos de 60 s: no se repite')
      return
    }
    let marca: string | null = null
    if (options.length && deps.database.marcarUltimaLista) {
      const propuesta = nuevaMarca()
      // Si no se pudo guardar, la lista sale SIN marca: el toque se aceptará
      // como hasta hoy, en vez de parecer viejo y dejar al cliente atascado.
      const guardada = await deps.database.marcarUltimaLista(customerId, propuesta).catch(() => false)
      marca = guardada ? propuesta : null
    }
    await deps.send(reply, options, marca)
    await anotar(huella)
  }

  const sendLink = deps.sendLink
    ? async (mensaje: { body: string; url: string; label: string; footer?: string | null }) => {
        const huella = huellaDeRespuesta(mensaje.body, [mensaje.url])
        // `true`: ya lo tiene en pantalla. Con `false` el llamador mandaría el
        // enlace en texto, que es justo la repetición que se quiere evitar.
        if (repetida(huella)) return true
        const enviado = await deps.sendLink!(mensaje)
        if (enviado) await anotar(huella)
        return enviado
      }
    : undefined

  return { send, sendLink } as Pick<D, 'send' | 'sendLink'>
}
