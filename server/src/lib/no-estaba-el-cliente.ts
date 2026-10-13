// ═══════════════════════════════════════════════════════════════════════════
// «LLEGUÉ» Y «NO ESTABA EL CLIENTE» (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo comparten la app del repartidor y el panel del local que reparte él
// mismo, para que las dos digan lo mismo con las mismas palabras. Las reglas
// —quién lleva el pedido, cuánto se espera, el dinero— viven en PostgreSQL
// (`migration-2026-10-12-no-estaba-el-cliente.sql`); aquí solo se traduce lo
// que responde la base.

/**
 * La ubicación del teléfono al tocar «Llegué», si la mandó y es un punto de
 * verdad. Es OPCIONAL y nunca bloquea: el GPS falla en interiores, y sin ella
 * solo se pierde la distancia que mira Umbani si el cliente dice «sí estaba».
 */
export function leerUbicacion(body: unknown): { lat: number; lng: number } | null {
  const datos = (body || {}) as Record<string, unknown>
  if (datos.lat == null || datos.lng == null || datos.lat === '' || datos.lng === '') return null
  const lat = Number(datos.lat)
  const lng = Number(datos.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** El id del pedido de la ruta, o null: uno mal escrito es «no existe», no un fallo de la base. */
export const idDelPedido = (valor: unknown): string | null => {
  const id = String(valor ?? '').trim()
  return UUID.test(id) ? id : null
}

/**
 * Lo que la base dijo que NO, dicho para quien está en la puerta. La espera
 * se cuenta desde la hora que dio la base (`noEstabaDesde`): el número de
 * minutos se ajusta sin publicar app, así que no se escribe aquí.
 */
export function respuestaDeLaPuerta(r: Record<string, unknown>, ahora = Date.now()): { status: number; body: Record<string, unknown> } {
  switch (r.result) {
    case 'not_found':
      return { status: 404, body: { error: 'No encontramos ese pedido' } }
    case 'no_en_camino':
      return { status: 409, body: { error: 'Ese pedido no está en camino', reason: r.result } }
    case 'sin_llegada':
      return { status: 409, body: { error: 'Primero toca «Llegué» cuando estés en la puerta', reason: r.result } }
    case 'todavia_no': {
      const desde = new Date(String(r.noEstabaDesde ?? '')).getTime()
      const faltan = Number.isFinite(desde) ? Math.max(1, Math.ceil((desde - ahora) / 60_000)) : null
      return {
        status: 409,
        body: {
          error: faltan
            ? `Espera al cliente ${faltan} ${faltan === 1 ? 'minuto' : 'minutos'} más antes de marcarlo`
            : 'Espera al cliente un poco más antes de marcarlo',
          reason: r.result,
          noEstabaDesde: r.noEstabaDesde ?? null,
        },
      }
    }
    default:
      return { status: 409, body: { error: 'Ese pedido no se puede cerrar ahora', reason: r.result ?? null } }
  }
}
