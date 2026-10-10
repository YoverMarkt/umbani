// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» — lo común a la tienda y a la app (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// El cliente dice «Todo bien» o reporta qué faltó, qué vino mal o que no llegó.
// Las reglas viven en la base (`customer_confirm_order`,
// `customer_report_order`); aquí se le dice cada respuesta con palabras, y se
// le pega a cada pedido de una lista su estado, de una sola vez.

const db = require('../db') as typeof import('../db')

export const RESPUESTA_AL_CLIENTE: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: 'No encontramos ese pedido' },
  no_entregado: { status: 409, error: 'Tu pedido todavía no se ha entregado' },
  ya_reclamado: { status: 409, error: 'Ya nos contaste de este pedido: lo estamos revisando' },
  fuera_de_plazo: { status: 409, error: 'Pasaron más de 48 horas desde la entrega. Escríbenos y lo vemos.' },
  tipo_invalido: { status: 400, error: 'Dinos qué pasó: faltó algo, vino mal o no llegó' },
  sin_lineas: { status: 400, error: 'Elige qué faltó o qué vino mal' },
  linea_invalida: { status: 400, error: 'Revisa lo que elegiste: no coincide con tu pedido' },
  nota_larga: { status: 400, error: 'La nota es muy larga: máximo 500 caracteres' },
  foto_invalida: { status: 400, error: 'Esa foto no es de este pedido. Súbela otra vez.' },
}
const NO_SE_PUDO = { status: 409, error: 'No pudimos registrarlo. Inténtalo de nuevo.' }
export const respuestaAlCliente = (resultado: unknown) => RESPUESTA_AL_CLIENTE[String(resultado)] || NO_SE_PUDO

/** Lo que llega en el cuerpo de un reclamo, sin confiar en nada. */
export function leerReclamo(body: unknown) {
  const datos = (body || {}) as Record<string, unknown>
  const lineas = Array.isArray(datos.lineas)
    ? datos.lineas.slice(0, 50).map(l => {
      const linea = (l || {}) as Record<string, unknown>
      return { item: String(linea.item ?? ''), cantidad: String(linea.cantidad ?? '') }
    })
    : []
  return {
    tipo: String(datos.tipo ?? ''),
    lineas,
    nota: typeof datos.nota === 'string' ? datos.nota.slice(0, 600) : null,
    // El identificador que devolvió la subida de la foto; la base comprueba que es de este pedido.
    foto: typeof datos.foto === 'string' && datos.foto.trim() ? datos.foto.trim().slice(0, 300) : null,
  }
}

const dinero = (centavos: number) => `$${Math.floor(centavos / 100)},${String(centavos % 100).padStart(2, '0')}`

/**
 * Lo que la app le dice al cliente después de reportar (2026-10-10). Se
 * escribe AQUÍ, como los errores, para que todas las apps digan lo mismo.
 * ⚠️ Nunca le explica la regla: si no se aprobó al instante, «lo estamos
 * revisando», sin decirle por qué (así no se aprende a esquivarla).
 */
export function respuestaDelReclamo(tipo: string, r: Record<string, unknown>) {
  const estado = r.estado === 'compensada' ? 'compensada' : 'abierta'
  const sugeridoCents = Number(r.sugeridoCents) || 0
  const saldoCents = Number(r.saldoCents) || 0
  const venceEl = typeof r.venceEl === 'string' && r.venceEl ? r.venceEl : null
  let mensaje: string
  if (estado === 'compensada' && saldoCents > 0) {
    const hasta = venceEl
      ? new Date(venceEl).toLocaleDateString('es-EC', { day: 'numeric', month: 'long', timeZone: 'America/Guayaquil' })
      : null
    mensaje = `Listo: te devolvimos ${dinero(saldoCents)} en saldo Umbani. Lo usas en tu próximo pedido, en cualquier local`
      + (hasta ? `, hasta el ${hasta}.` : '.')
  } else if (tipo === 'no_llego' && sugeridoCents === 0) {
    mensaje = 'Como ibas a pagar al recibir, no se te cobró nada. Revisamos qué pasó con el repartidor.'
  } else {
    mensaje = 'Lo estamos revisando. Te avisamos apenas tengamos una respuesta.'
  }
  return { ok: true, estado, sugeridoCents, saldoCents, venceEl, mensaje }
}

/** Cada pedido de la lista con su `confirmacion`: «todo bien», su reclamo y hasta cuándo puede reclamar. */
export async function conConfirmacion<T extends Record<string, unknown>>(pedidos: T[]): Promise<(T & { confirmacion: unknown })[]> {
  const estados = await db.claimStates(pedidos.map(p => ({
    id: String(p.id), status: String(p.status), received_ok_at: (p.received_ok_at as string | null) ?? null,
  })))
  return pedidos.map(p => ({ ...p, confirmacion: estados.get(String(p.id)) ?? null }))
}
