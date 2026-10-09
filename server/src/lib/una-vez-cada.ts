// ═══════════════════════════════════════════════════════════════════════════
// UNA LECTURA CADA TANTO, COMPARTIDA POR TODOS LOS QUE PREGUNTEN (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Nació para `/api/health`, que es pública y no lleva limitador A PROPÓSITO:
// Railway la usa para saber si el contenedor vive, y un 429 ahí sería un
// reinicio en bucle. Pero cada llamada consultaba la base, así que cualquiera
// podía convertir mil peticiones por segundo en mil consultas por segundo
// contra Supabase. Con esto la base se consulta como mucho una vez cada `ms`,
// lleguen las que lleguen; las que llegan mientras tanto comparten respuesta.
//
// ⚠️ Solo para lecturas INFORMATIVAS e iguales para todos. Nada de un negocio
// ni de un cliente: una respuesta compartida no sabe quién pregunta.

export function unaVezCada<T>(ms: number, leer: () => Promise<T>, ahora: () => number = Date.now): () => Promise<T> {
  let ultima: { en: number; valor: Promise<T> } | null = null
  return () => {
    const t = ahora()
    if (ultima && t - ultima.en < ms) return ultima.valor
    const esta = { en: t, valor: leer() }
    ultima = esta
    // Un fallo no se guarda: la pregunta siguiente lo vuelve a intentar.
    esta.valor.catch(() => { if (ultima === esta) ultima = null })
    return esta.valor
  }
}
