// ═══════════════════════════════════════════════════════════════════════════
// EL FRENO: arrancar en local no puede tocar la base de producción
// ═══════════════════════════════════════════════════════════════════════════
//
// `server/.env` apunta a la base REAL. Eso hace que encender el servidor en un
// portátil para mirar una pantalla dispare, contra los datos de los clientes:
//
//   · el worker de la cola de webhooks — procesa mensajes de gente real desde
//     tu máquina, y contesta con las credenciales de producción;
//   · a los 3 s, la facturación del mes;
//   · a los 5, 7 y 9 s, tres limpiezas que BORRAN filas;
//   · a los 12 s, las comisiones;
//   · a los 20 s, la revisión de credenciales contra los proveedores;
//   · **a los 30 s, `expireUnpaidOrders`, que CANCELA pedidos** que pasaron su
//     ventana. Pedidos de verdad, de clientes de verdad;
//   · a los 60 s, el canario recorriendo el catálogo real;
//   · y Telegram en modo polling, que para poder escuchar **borra el webhook**
//     que tenga puesto producción.
//
// Ninguna de esas tareas sabe que está en un portátil, porque desde la base no
// se nota la diferencia. Este módulo es lo que las distingue.
//
// ⚠️ EN PRODUCCIÓN NO CAMBIA ABSOLUTAMENTE NADA. El freno solo puede actuar
// cuando el proceso NO es producción, y esa es la única condición que hay que
// no romper nunca al tocar este archivo.

import { esStaging, isProductionEnvironment } from './environment'

/** Se pone a `si` para arrancar en local contra la base real a propósito. */
export const ESCAPE_ENV = 'PERMITIR_TAREAS_CONTRA_PRODUCCION'

export interface DecisionDeTareas {
  /** `true` = arrancan las tareas de fondo, como siempre. */
  permitido: boolean
  /** Explicación en español, para el log del arranque. */
  motivo: string
}

const HOSTS_LOCALES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  // La CLI de Supabase levanta su pasarela aquí; desde dentro de Docker, el
  // servidor la ve con estos otros dos nombres.
  'host.docker.internal',
  'kong',
  'supabase_kong',
])

/** ¿La base a la que apunta este proceso vive en esta máquina? */
export function apuntaAUnaBaseLocal(supabaseUrl: string | undefined): boolean {
  if (!supabaseUrl?.trim()) return false
  try {
    return HOSTS_LOCALES.has(new URL(supabaseUrl).hostname)
  } catch {
    // Una URL que no se puede leer no se puede declarar local: ante la duda,
    // se asume remota y el freno actúa. Equivocarse hacia el lado seguro aquí
    // cuesta un arranque sin tareas; hacia el otro, pedidos cancelados.
    return false
  }
}

/**
 * ¿Deben arrancar las tareas de fondo en este proceso?
 *
 * Tres casos y solo tres:
 *
 *  1. **Es producción** → sí, siempre. Es su trabajo.
 *  2. **Es local contra una base local** → sí. Las tareas son inofensivas ahí,
 *     y además conviene que corran: si la facturación o la expiración de
 *     pedidos se rompen, es justo en staging donde hay que enterarse.
 *  3. **Es local contra una base remota** → NO, salvo que se pida a propósito.
 */
export function decidirTareasDeFondo(env: NodeJS.ProcessEnv): DecisionDeTareas {
  if (isProductionEnvironment(env)) {
    // El staging en internet (Railway) también llega aquí: es un despliegue de
    // verdad contra SU base, y el candado del arranque ya comprobó que no es la
    // de producción. Solo cambia cómo se dice en el registro.
    return { permitido: true, motivo: esStaging(env) ? 'staging en internet' : 'producción' }
  }

  if (apuntaAUnaBaseLocal(env.SUPABASE_URL)) {
    return { permitido: true, motivo: 'base local' }
  }

  if (env[ESCAPE_ENV]?.trim().toLowerCase() === 'si') {
    return {
      permitido: true,
      motivo: `${ESCAPE_ENV}=si — a propósito contra la base real`,
    }
  }

  return {
    permitido: false,
    motivo: 'local apuntando a una base REMOTA',
  }
}

/** Lo que se imprime al arrancar, para que nadie tenga que adivinar. */
export function explicarDecision(decision: DecisionDeTareas): string[] {
  if (decision.permitido) {
    return [`⚙️  Tareas de fondo: activas (${decision.motivo}).`]
  }
  return [
    '',
    '🛑 TAREAS DE FONDO APAGADAS — este proceso es local y la base es remota.',
    '',
    '   No arrancan: la cola de webhooks, la facturación, las limpiezas, las',
    '   comisiones, la revisión de credenciales, el canario, la expiración de',
    '   pedidos ni Telegram. Contra la base real, esas tareas escriben de',
    '   verdad: llegan a CANCELAR pedidos de clientes desde tu máquina.',
    '',
    '   El servidor y sus rutas funcionan con normalidad: puedes usar los',
    '   paneles, la tienda y el simulador.',
    '',
    `   Para hacerlo a propósito: ${ESCAPE_ENV}=si`,
    '',
  ]
}
