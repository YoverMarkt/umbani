import { isIP, isIPv4 } from 'node:net'
import type { RequestHandler } from 'express'
import { esDeCloudflare } from '../lib/rangos-de-cloudflare'

// ═══════════════════════════════════════════════════════════════════════════
// QUIÉN ES EL CLIENTE DETRÁS DE RAILWAY (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Todos los frenos contra abusos (`express-rate-limit`) cuentan por `req.ip`,
// y `req.ip` sale de `X-Forwarded-For` según en qué saltos se confía.
//
// ⚠️ CONTABAN POR NODO DE RAILWAY, NO POR CLIENTE. Lo destapó la prueba de
// carga: una sola IP veía VARIOS contadores en `RateLimit-Remaining` (89, 88,
// 89, 88… en el staging; al menos cuatro en producción). Con un diagnóstico
// en el staging se vio la cadena de verdad:
//
//   conexión           ::ffff:100.64.0.x            el proxy interno de Railway
//   X-Forwarded-For    <cliente>, 152.233.23.19x    ← su borde, una CDN en Miami
//   X-Real-IP          <cliente>
//
// Con `trust proxy 1`, Express se quedaba con la de la derecha: el nodo de la
// CDN (hay dos, de ahí los contadores). Así, el freno de pedidos (8 por
// minuto), el de códigos o el de fallos de login eran para TODOS los clientes
// que pasaban por el mismo nodo. Y no basta con confiar en la red de Railway
// (100.x): el nodo de la CDN no es de ella, y su rango no es estable.
//
// La fuente buena es `X-Real-IP`: la escribe Railway con el cliente que ve. Se
// comprobó que el borde TIRA lo que mande el cliente —un `X-Real-IP` y un
// `X-Forwarded-For` inventados no llegaron—. Así que, cuando la conexión viene
// del proxy de Railway, la cadena se reduce a ese cliente y Express lo toma.
//
// ⚠️ Falla hacia lo seguro. Solo se cree `X-Real-IP` si la CONEXIÓN viene de la
// red de Railway: quien llegara por otro camino (en local, el 127.0.0.1) no
// puede usarla para saltarse un freno. Si Railway dejara de mandarla, se vuelve
// a contar como antes —por nodo—, nunca por lo que diga el cliente. ⚠️ Nunca
// `trust proxy = true`: mandaría la entrada de la izquierda, la que escribiría
// quien quisiera colarse si el borde dejara de reescribir.
// ⚠️ Los recorridos simulan cada archivo desde una red `10.x` con
// `X-Forwarded-For` desde 127.0.0.1: no es Railway, y siguen igual.
//
// ── CON CLOUDFLARE DELANTE (preparado el 2026-10-09, para el dominio) ──────
//
// Cuando el dominio pase por Cloudflare, Railway verá llegar a Cloudflare: su
// `X-Real-IP` será un nodo de Cloudflare y, sin más, los frenos volverían a
// contar por nodo. El cliente de verdad viene en `CF-Connecting-IP`, y se cree
// SOLO si el `X-Real-IP` que escribió Railway es de una red de Cloudflare
// (`lib/rangos-de-cloudflare.ts`). Quien le hable a Railway directamente —la
// dirección `railway.app` sigue abierta— puede inventarse esa cabecera, pero
// su `X-Real-IP` es el suyo, no el de Cloudflare: se ignora y cuenta como él.
// Hasta el domingo no hay Cloudflare delante, así que esta rama no se pisa.

/** Los saltos de red que son nuestros: locales, privados y la red de Railway. */
export const PROXIES_DE_CONFIANZA = ['loopback', 'linklocal', 'uniquelocal', '100.0.0.0/8']

/** ¿Esta conexión la abre el proxy de Railway (100.x.x.x, también escrita como IPv6)? */
export function vieneDelProxyDeRailway(direccion: string | undefined): boolean {
  const ipv4 = (direccion ?? '').replace(/^::ffff:/i, '')
  return isIPv4(ipv4) && ipv4.startsWith('100.')
}

const UNA_HORA = 60 * 60 * 1000
let ultimoAviso = 0

/**
 * Un `CF-Connecting-IP` desde fuera de Cloudflare. Antes del dominio, alguien
 * que prueba suerte; con Cloudflare delante, puede ser una red NUEVA de
 * Cloudflare que falta en la lista, y entonces se vuelve a contar por nodo sin
 * que nada falle. Se avisa en el registro, una vez por hora como mucho: un
 * ataque no tiene que inundarlo.
 */
function avisarCabeceraFueraDeCloudflare(borde: string): void {
  const ahora = Date.now()
  if (ahora - ultimoAviso < UNA_HORA) return
  ultimoAviso = ahora
  console.warn(`⚠️ CF-Connecting-IP desde ${borde}, que no es una red de Cloudflare: se ignora. `
    + 'Si Cloudflare ya está delante, quizá publicó una red nueva: revisa lib/rangos-de-cloudflare.ts.')
}

/** El cliente, visto lo que Railway dice del borde (`X-Real-IP`) y lo que diga Cloudflare. */
function clienteTrasElBorde(
  borde: string,
  cabeceraDeCloudflare: string | string[] | undefined,
  esCloudflare: (direccion: string | undefined) => boolean,
  avisar: (borde: string) => void,
): string {
  const cliente = typeof cabeceraDeCloudflare === 'string' ? cabeceraDeCloudflare.trim() : ''
  if (!cliente) return borde
  if (!esCloudflare(borde)) {
    avisar(borde)
    return borde
  }
  // Lo que no es UNA IP (vacío, basura, dos juntas) no vale: cuenta el nodo.
  return isIP(cliente) ? cliente : borde
}

/**
 * Detrás de Railway, el cliente es su `X-Real-IP`: la cadena se reduce a él.
 * Y si ese `X-Real-IP` es un nodo de Cloudflare, el cliente es el que dice
 * Cloudflare en `CF-Connecting-IP`.
 */
export function crearClienteSegunRailway(
  esRailway: (direccion: string | undefined) => boolean = vieneDelProxyDeRailway,
  esCloudflare: (direccion: string | undefined) => boolean = esDeCloudflare,
  avisar: (borde: string) => void = avisarCabeceraFueraDeCloudflare,
): RequestHandler {
  return (req, _res, next) => {
    const real = req.headers['x-real-ip']
    const ip = typeof real === 'string' ? real.trim() : ''
    if (ip && isIP(ip) && esRailway(req.socket.remoteAddress)) {
      req.headers['x-forwarded-for'] = clienteTrasElBorde(ip, req.headers['cf-connecting-ip'], esCloudflare, avisar)
    }
    next()
  }
}

export const clienteSegunRailway = crearClienteSegunRailway()
