-- ============================================================================
-- LOS LOCALES DE DEMOSTRACIÓN: SU DINERO NUNCA SE MEZCLA CON EL REAL
--
-- Para negociar con los dueños de locales (decisión del dueño, 2026-09-30):
-- enseñar un pedido pagado de punta a punta, su estado de cuenta semanal y una
-- devolución, en un local que ellos mismos puedan tocar. Los 15 locales de
-- muestra (los de `notes` «LOCAL DE MUESTRA…», creados el 2026-09-25) sirven,
-- pero su dinero entraba en las cuentas de verdad: un pedido de demo con la
-- tarjeta de PRUEBAS, entregado, habría hecho que el cierre del lunes dijera
-- «Umbani le debe $X a Burger Brava» por un dinero que nunca existió.
--
-- `is_demo` lo aparta, sin esconderlo: el local de demo sigue el camino normal
-- (pedido, libro, cierre del lunes, «Mis pagos»), para que se vea igual que uno
-- real; pero su liquidación NO se puede marcar pagada, y lo que gana Umbani no
-- lo cuenta. El superadmin lo ve aparte, con su etiqueta «Demo».
--
-- ⚠️ Se marca por la marca de `notes` UNA vez, aquí. Desde ahora la verdad es
-- `is_demo`; y cambiarla queda en el registro de dinero, porque decide si
-- Umbani paga o no a un local.
-- ============================================================================

alter table public.businesses
  add column if not exists is_demo boolean not null default false;

comment on column public.businesses.is_demo is
  'Local de demostración: su dinero es de prueba. Su liquidación no se paga y no cuenta en lo que gana Umbani.';

update public.businesses
   set is_demo = true
 where notes like 'LOCAL DE MUESTRA%'
   and not is_demo;

-- Cambiar la marca queda en el registro de dinero. Se crea DESPUÉS de marcar
-- los 15 de muestra: esa decisión está escrita aquí, no hace falta repetirla.
create or replace function public.businesses_registro_demo()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.id, 'local_demo', 'businesses',
    new.id::text, jsonb_build_object('antes', old.is_demo, 'despues', new.is_demo));
  return null;
end;
$$;

revoke all on function public.businesses_registro_demo() from public, anon, authenticated;

drop trigger if exists businesses_registro_demo on public.businesses;
create trigger businesses_registro_demo
  after update of is_demo on public.businesses
  for each row when (old.is_demo is distinct from new.is_demo)
  execute function public.businesses_registro_demo();

create or replace function public.mark_settlement_paid(
  p_settlement_id uuid,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_fila public.settlements%rowtype;
begin
  -- ⚠️ Un local de DEMOSTRACIÓN no se paga (2026-09-30): su dinero es de
  -- prueba. Su liquidación existe para que «Mis pagos» se vea como uno real.
  if exists (
    select 1 from public.settlements s join public.businesses b on b.id = s.business_id
     where s.id = p_settlement_id and b.is_demo
  ) then
    return jsonb_build_object('result', 'demo');
  end if;

  if v_ref is null or char_length(v_ref) < 3 then
    raise exception using errcode = '22023',
      message = 'Escribe la referencia de la transferencia.';
  end if;

  update public.settlements
     set status = case status when 'por_pagar' then 'pagada' else 'cobrada' end,
         paid_at = now(), reference = left(v_ref, 120), updated_at = now()
   where id = p_settlement_id and status in ('por_pagar', 'por_cobrar')
  returning * into v_fila;

  if not found then
    return jsonb_build_object('result', 'not_pending');
  end if;
  return jsonb_build_object('result', 'updated', 'status', v_fila.status);
end;
$$;

revoke all on function public.mark_settlement_paid(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_settlement_paid(uuid, text) to service_role;

-- ⚠️ La versión VIVA del resumen (la de `reparto` y `productos`), con
-- `create or replace`: mismas columnas, así que se puede sin `drop`.
create or replace function public.platform_markup_summary(
  p_from        date,
  p_to          date,
  p_business_id uuid default null
)
returns table (
  business_id   uuid,
  business_name text,
  pedidos       bigint,
  -- Lo que pago el cliente, entero: productos + reparto + margen.
  bruto         numeric,
  -- De la PLATAFORMA. La factura del mes sale de aqui.
  margen        numeric,
  -- De QUIEN ENTREGA. Ni del local ni de la plataforma.
  reparto       numeric,
  -- Del LOCAL, por su comida. Su venta de verdad.
  productos     numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.business_id,
    max(b.name)                                    as business_name,
    count(*)                                       as pedidos,
    round(coalesce(sum(s.total), 0), 2)            as bruto,
    round(coalesce(sum(o.platform_markup), 0), 2)  as margen,
    -- Una venta sin pedido —cita, estadia, mostrador— no tiene carrera: ahi
    -- `reparto` es 0 y `productos` se lleva todo.
    round(coalesce(sum(o.shipping), 0), 2)         as reparto,
    round(coalesce(sum(s.total), 0)
        - coalesce(sum(o.platform_markup), 0)
        - coalesce(sum(o.shipping), 0), 2)         as productos
  from public.sales s
  join public.businesses b on b.id = s.business_id
  left join public.orders o on o.id = s.order_id
  where s.status = 'completada'
    -- El día empieza y acaba en Ecuador. Sin esto, las ventas de 19:00 a
    -- medianoche —la franja de más movimiento— caen en el día siguiente, y
    -- las del último día del mes, en el mes siguiente.
    and s.sold_at >= (p_from::timestamp at time zone 'America/Guayaquil')
    and s.sold_at <  (p_to::timestamp   at time zone 'America/Guayaquil')
    and (p_business_id is null or s.business_id = p_business_id)
    -- ⚠️ Lo que gana Umbani no cuenta los locales de DEMOSTRACIÓN (2026-09-30),
    -- salvo que se pregunte por ese local: entonces ve lo suyo.
    and (p_business_id is not null or not b.is_demo)
  group by s.business_id
  order by round(coalesce(sum(o.platform_markup), 0), 2) desc;
$$;

revoke all on function public.platform_markup_summary(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_markup_summary(date, date, uuid)
  to service_role;
