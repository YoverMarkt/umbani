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
