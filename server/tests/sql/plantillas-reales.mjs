// ═══════════════════════════════════════════════════════════════════════════
// LAS PLANTILLAS REALES DEL ALTA, CONTRA POSTGRESQL
// ═══════════════════════════════════════════════════════════════════════════
//
// Escribe en la salida un SQL que da de alta un negocio por CADA tipo con
// plantilla y le aplica la plantilla de verdad —la de
// `services/plantillas-por-tipo.ts`, no una copia escrita a mano—, dentro de
// una transacción que se deshace.
//
// ⚠️ Existe porque este fallo es SILENCIOSO. El alta se traga el error de la
// plantilla a propósito (un negocio ya creado no puede devolver un 500), así
// que una plantilla que la base rechace —un grupo mal formado, una parte del
// plato colgada de una categoría, una lista que no existe— deja al local
// naciendo con el catálogo vacío y el motivo escondido en el registro de
// errores. `plantillas-negocio.test.js` replica las reglas de la base; esto
// pregunta a la base misma.
//
//   node server/tests/sql/plantillas-reales.mjs > plantillas.sql
//   psql … -f plantillas.sql
//
// Lee el TypeScript directamente (Node quita los tipos), así que no necesita
// compilar el servidor: el trabajo del esquema en el CI no instala nada.

import {
  businessTypesWithTemplate,
  templateForBusinessType,
} from '../../src/services/plantillas-por-tipo.ts'

const literal = valor => `'${String(valor).replace(/'/g, "''")}'`

const bloques = businessTypesWithTemplate().map((tipo, posicion) => {
  const telefono = `+5939007770${String(posicion + 1).padStart(2, '0')}`
  const plantilla = JSON.stringify(templateForBusinessType(tipo))
  return `
  insert into businesses (slug, name, type, whatsapp_provider, whatsapp_number,
    ycloud_number, takes_orders)
  values (${literal(`plantilla-real-${posicion + 1}`)}, ${literal(tipo)}, ${literal(tipo)},
    'ycloud', ${literal(telefono)}, ${literal(telefono)}, true)
  returning id into v_negocio;

  v_resultado := public.apply_business_template(v_negocio, ${literal(plantilla)}::jsonb);
  if (v_resultado->>'aplicada')::boolean is not true then
    raise exception 'La plantilla de «%» no se aplicó: %', ${literal(tipo)}, v_resultado;
  end if;
  -- Cada local nace con algo que enseñe cómo se arma (2026-09-16).
  if (v_resultado->>'productos')::integer < 1 then
    raise exception '«%» nació sin producto de ejemplo', ${literal(tipo)};
  end if;
  -- Y ese ejemplo, con su precio inventado, no puede estar a la venta…
  if exists (select 1 from products where business_id = v_negocio and stock <> 'agotado') then
    raise exception '«%» nació con un producto de ejemplo a la venta', ${literal(tipo)};
  end if;
  -- …pero sí a la vista de su dueño: inactivo es BORRADO y el panel no lo lista.
  if exists (select 1 from products where business_id = v_negocio and not active) then
    raise exception '«%» nació con el ejemplo borrado: su dueño no lo vería', ${literal(tipo)};
  end if;
  -- Un grupo vivo sin opciones no existe para el cliente: la tienda lo
  -- descarta. Sería una lista enlazada que no llegó a copiarse.
  if exists (
    select 1 from option_groups g
    where g.business_id = v_negocio and g.active
      and not exists (select 1 from options o where o.option_group_id = g.id)
  ) then
    raise exception '«%» nació con un grupo vacío', ${literal(tipo)};
  end if;
  raise notice '✓ % → %', ${literal(tipo)}, v_resultado;`
})

process.stdout.write(`-- Generado por server/tests/sql/plantillas-reales.mjs. No editar a mano.
begin;
do $plantillas_reales$
declare
  v_negocio uuid;
  v_resultado jsonb;
begin
${bloques.join('\n')}
  raise notice 'PLANTILLAS REALES: los ${bloques.length} tipos nacen armados y aceptados por la base';
end;
$plantillas_reales$;
rollback;
`)
