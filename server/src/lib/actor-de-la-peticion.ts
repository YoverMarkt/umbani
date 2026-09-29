import { AsyncLocalStorage } from 'node:async_hooks'

// ═══════════════════════════════════════════════════════════════════════════
// QUIÉN ESTÁ HACIENDO ESTO — para el registro de quién mueve dinero
// ═══════════════════════════════════════════════════════════════════════════
//
// El registro lo escribe la BASE, con disparadores en cada tabla de dinero
// (`migration-2026-09-29-registro-de-dinero.sql`). La base sabe QUÉ cambió;
// esto le dice QUIÉN, en la cabecera `x-umbani-actor` que PostgREST le deja en
// `request.headers`.
//
// ⚠️ Se pone UNA vez, al autenticar (`middleware/auth.ts`), y viaja sola en
// cada consulta de esa petición gracias al `fetch` del cliente de la base. Así
// una ruta que se escriba mañana deja su rastro sin tener que acordarse — que
// es justo el fallo que este proyecto conoce mejor: construido y desconectado.
//
// Sin actor (las tareas de fondo) la base anota `sistema`, que es la verdad.

const almacen = new AsyncLocalStorage<{ actor: string }>()

/** Lo que admite una cabecera HTTP: ASCII imprimible, sin saltos de línea. */
const limpio = (actor: string): string => String(actor || '')
  .replace(/[^\x20-\x7e]/g, '')
  .trim()
  .slice(0, 200)

/** Corre `fn` —y todo lo que espere— sabiendo quién lo pidió. */
export function conActor<T>(actor: string, fn: () => T): T {
  const valor = limpio(actor)
  return valor ? almacen.run({ actor: valor }, fn) : fn()
}

/** Quién está detrás de lo que se ejecuta ahora mismo, si alguien lo está. */
export const actorActual = (): string | null => almacen.getStore()?.actor ?? null

export const CABECERA_DEL_ACTOR = 'x-umbani-actor'

/**
 * El `fetch` del cliente de la base, con el actor en la cabecera.
 *
 * ⚠️ Solo la AÑADE: si no hay actor, la petición sale exactamente igual que
 * antes. Y nunca pisa una cabecera que ya viniera puesta.
 */
export function conActorEnLaCabecera(base: typeof fetch): typeof fetch {
  return (entrada, opciones) => {
    const actor = actorActual()
    if (!actor) return base(entrada, opciones)
    const cabeceras = new Headers(opciones?.headers)
    if (!cabeceras.has(CABECERA_DEL_ACTOR)) cabeceras.set(CABECERA_DEL_ACTOR, actor)
    return base(entrada, { ...opciones, headers: cabeceras })
  }
}
