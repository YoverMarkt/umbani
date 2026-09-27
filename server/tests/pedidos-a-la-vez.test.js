import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// DOS PEDIDOS A LA VEZ EN EL MISMO LOCAL NO PUEDEN CHOCAR (2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo destapó la batería de recorridos de clientes en staging: con 10 clientes
// pidiendo a la vez en el mismo local, 8 pedidos fallaban con «deadlock
// detected». `create_storefront_order` bloqueaba el local con FOR SHARE y el
// disparador que numera el pedido ESCRIBÍA en esa misma fila: cada uno
// esperaba al otro. Con el arreglo: 10 de 10, y 20 de 20 sin un choque.
//
// La concurrencia no se puede probar en `verificar-esquema.sql` (es UNA
// sesión), así que se vigila el patrón en el propio esquema.

const esquema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')

/** La ÚLTIMA definición de cada función: es la que vive en la base. */
const funciones = () => {
  const vigentes = new Map()
  for (const m of esquema.matchAll(/create or replace function public\.([a-z_0-9]+)\(([\s\S]*?)\$\$;/g)) {
    vigentes.set(m[1], m[0].replace(/--[^\n]*/g, ''))
  }
  return vigentes
}

describe('ningún pedido choca con otro del mismo local', () => {
  it('el disparador que numera los pedidos sigue escribiendo en la fila del local', () => {
    // Es la mitad del choque: si algún día deja de hacerlo, este guardián
    // habrá que repensarlo, no borrarlo.
    const numerar = funciones().get('assign_order_number')
    expect(numerar).toMatch(/update\s+public\.businesses\s+set\s+last_order_number/)
  })

  it('crear el pedido toma el bloqueo de escritura del local desde el principio', () => {
    const crear = funciones().get('create_storefront_order')
    expect(crear).toMatch(/from\s+public\.businesses\s+where\s+id\s*=\s*p_business_id\s+for\s+no\s+key\s+update/)
  })

  it('ninguna función bloquea el local con FOR SHARE y luego crea pedidos o lo escribe', () => {
    const culpables = []
    for (const [nombre, cuerpo] of funciones()) {
      const comparte = /from\s+public\.businesses\b[^;]*?\bfor\s+share\b/.test(cuerpo)
      const escribe = /insert\s+into\s+public\.orders\b/.test(cuerpo) || /update\s+public\.businesses\b/.test(cuerpo)
      if (comparte && escribe) culpables.push(nombre)
    }
    expect(culpables, 'FOR SHARE sobre el local + escribir en él (o crear un pedido, que lo '
      + 'escribe al numerarse) = dos pedidos a la vez se bloquean mutuamente. Usa FOR NO KEY UPDATE.')
      .toEqual([])
  })

  it('caza de verdad el patrón que tumbaba los pedidos', () => {
    const viejo = `create or replace function public.x() returns void as $$
      begin
        select id into v from public.businesses where id = p for share;
        insert into public.orders (business_id) values (p);
      end $$;`
    expect(/from\s+public\.businesses\b[^;]*?\bfor\s+share\b/.test(viejo)
      && /insert\s+into\s+public\.orders\b/.test(viejo)).toBe(true)
  })
})
