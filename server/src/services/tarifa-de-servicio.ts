// ═══════════════════════════════════════════════════════════════════════════
// LA TARIFA DE SERVICIO QUE SE ENSEÑA
// ═══════════════════════════════════════════════════════════════════════════
//
// La COBRA la base (`orders_stamp_pricing` + `tarifa_de_servicio()`); aquí solo
// se pide para enseñarla en el carrito antes de confirmar. Un minuto en
// memoria: cada apertura de la tienda la necesita, y cambia a mano, muy de
// vez en cuando. Si la consulta falla se enseña la última conocida (o 0): el
// importe que se cobra lo decide la base igualmente.

let valor = 0
/** `null` = todavía no se leyó nunca (no «se leyó en el instante 0»). */
let leidoEn: number | null = null
const VIGENCIA_MS = 60_000

export async function tarifaDeServicio(
  leer: () => Promise<number> = () => (require('../db') as typeof import('../db')).getServiceFee(),
  ahora: number = Date.now(),
): Promise<number> {
  if (leidoEn !== null && ahora - leidoEn < VIGENCIA_MS) return valor
  try {
    valor = await leer()
    leidoEn = ahora
  } catch { /* se queda la última conocida */ }
  return valor
}

/** Solo para las pruebas: olvidar lo leído. */
export function olvidarTarifa() { leidoEn = null; valor = 0 }
