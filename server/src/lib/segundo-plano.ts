// ═══════════════════════════════════════════════════════════════════════════
// LO QUE SE LANZA SIN ESPERAR, CON RASTRO
// ═══════════════════════════════════════════════════════════════════════════
//
// Registrar un error, apuntar el paso del menú, indexar un producto: el flujo
// real NO los espera, y está bien que no lo haga — la respuesta al cliente no
// puede depender de que se guarde un registro. Se lanzaban con `void` y nadie
// sabía cuántos seguían en vuelo.
//
// ⚠️ Nace el 2026-09-24 del CI que se ponía rojo SOLO, una de cada cuatro
// veces, con las 3.054 pruebas en verde: `EnvironmentTeardownError: Closing
// rpc while "onUserConsoleLog" was pending`. Un detector de logs fuera de
// prueba lo señaló a la primera: estos tres registros terminaban DESPUÉS de su
// prueba, su `console.error` viajaba al proceso de vitest cuando este ya
// cerraba, y reventaba. Dos arreglos de configuración se midieron antes y no
// sirvieron (ver `vitest.config.ts`): el problema no era la consola, era
// trabajo que nadie esperaba.
//
// Aquí se apunta lo que está en vuelo para que las pruebas lo esperen al
// cerrar cada una (`tests/setup-segundo-plano.js`).

const enVuelo = new Set<Promise<unknown>>()

/**
 * Deja constancia de una tarea que el llamador no va a esperar.
 *
 * Devuelve la MISMA promesa: quien sí quiera esperarla puede hacerlo, y quien
 * no, no cambia nada respecto al `void` de antes.
 *
 * ⚠️ Solo para tareas que ya se cuidan de sus propios errores (las tres de hoy
 * los atrapan y los escriben en la consola). El rastro no los propaga: si una
 * falla, sale del conjunto igual que si hubiera ido bien.
 */
export function enSegundoPlano<T>(tarea: Promise<T>): Promise<T> {
  enVuelo.add(tarea)
  const soltar = () => { enVuelo.delete(tarea) }
  tarea.then(soltar, soltar)
  return tarea
}

/**
 * Espera a que termine todo lo lanzado sin esperar, incluido lo que se lance
 * MIENTRAS se espera (un registro puede encadenar otro).
 */
export async function esperarSegundoPlano(): Promise<void> {
  while (enVuelo.size) await Promise.allSettled(enVuelo)
}
