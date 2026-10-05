// ═══════════════════════════════════════════════════════════════════════════
// ¿ESTE LOCAL TIENE SUS REPARTIDORES PROPIOS ENCENDIDOS? (2026-10-04)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño: se enciende local por local («si un local me dice que
// tiene su flota, solo le activamos a ellos»), en su ficha del superadmin.
// Solo cuenta si además reparte él mismo: con «Quién reparte: Umbani»,
// reparten los de Umbani y nadie más.
//
// ⚠️ La MISMA regla está en la base, en las tres puertas por las que un
// repartidor llega a un pedido (`courier_orders`, `courier_take_order`,
// `orders_courier_permitido`). Esto solo decide qué enseña y qué abre el
// panel del local; lo que de verdad impide que un repartidor lleve un pedido
// es la base. Si cambias una, cambia la otra.

export interface LocalConFlota {
  own_fleet?: boolean | null
  delivery_by?: string | null
}

export const tieneFlotaPropia = (local: LocalConFlota | null | undefined): boolean =>
  local?.own_fleet === true && local.delivery_by === 'local'
