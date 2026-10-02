// ═══════════════════════════════════════════════════════════════════════════
// LA FRANJA: saber de un vistazo que esto NO es producción
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño lo preguntó tal cual: «¿cómo sé cuándo se está en local y cuándo ya
// está todo en producción?». Por WhatsApp la respuesta es fácil —el número solo
// apunta a un sitio—, pero en el navegador dos pestañas iguales pueden ser la
// tienda de verdad y una copia con datos inventados.
//
// Así que lo dice la propia página. Con dos avisos distintos, porque son dos
// situaciones muy distintas:
//
//   · **STAGING** (base local): tranquilo, aquí no hay clientes.
//   · **BASE REAL** (local apuntando a producción): cuidado, lo que toques es
//     de verdad. Este es el que importa, y va en rojo.
//
// ⚠️ En producción devuelve `null` y el HTML se sirve intacto, por `sendFile`,
// con su ETag y sin leer el archivo a mano. Esa es la condición que no se puede
// romper al tocar este archivo.

import { esStaging, isProductionEnvironment } from '../config/environment'
import { apuntaAUnaBaseLocal } from '../config/tareas-de-fondo'

export interface AvisoDeEntorno {
  texto: string
  /** Color de fondo de la etiqueta. */
  color: string
}

/** Qué aviso toca, o `null` si esto es producción y no toca ninguno. */
export function avisoDeEntorno(env: NodeJS.ProcessEnv): AvisoDeEntorno | null {
  // ⚠️ ANTES que la pregunta de producción: el staging en internet corre en
  // Railway y para `isProductionEnvironment` es un despliegue de verdad. Sin
  // esto, el dueño abriría el staging en su móvil sin ninguna señal de que no
  // es la app de sus clientes (2026-10-01).
  if (esStaging(env)) return { texto: 'STAGING · datos de mentira', color: '#4338ca' }

  if (isProductionEnvironment(env)) return null

  if (apuntaAUnaBaseLocal(env.SUPABASE_URL)) {
    return { texto: 'STAGING · datos de mentira', color: '#4338ca' }
  }

  // Lo más importante que esta franja puede decir: estás en tu máquina, pero
  // lo que ves y tocas son los datos de los clientes.
  return { texto: '⚠️ LOCAL · BASE REAL', color: '#b91c1c' }
}

/**
 * La etiqueta, como HTML suelto.
 *
 * Abajo a la izquierda y pequeña: tiene que verse siempre sin taparle nada a
 * quien está probando. `pointer-events:none` para que nunca se coma un clic.
 */
export function franjaHtml(aviso: AvisoDeEntorno): string {
  return '<div style="'
    + 'position:fixed;left:8px;bottom:8px;z-index:2147483647;'
    + `background:${aviso.color};color:#fff;`
    + 'font:600 11px/1 system-ui,-apple-system,sans-serif;'
    + 'padding:6px 10px;border-radius:999px;opacity:.92;'
    + 'pointer-events:none;letter-spacing:.02em;'
    + `">${aviso.texto}</div>`
}

/**
 * Mete la etiqueta en el HTML de la SPA.
 *
 * Antes de `</body>` para no retrasar nada de lo que la página necesita. Si no
 * hubiera `</body>` —un HTML raro—, se añade al final: es preferible una
 * etiqueta mal colocada a una página sin aviso.
 */
export function inyectarFranja(html: string, aviso: AvisoDeEntorno): string {
  const franja = franjaHtml(aviso)
  const cierre = html.lastIndexOf('</body>')
  if (cierre === -1) return html + franja
  return html.slice(0, cierre) + franja + html.slice(cierre)
}
