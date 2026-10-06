-- ============================================================================
-- LAS CIUDADES: CADA CLIENTE VE LOS LOCALES DE LA SUYA
--
-- Decisión del dueño (2026-10-05): Umbani se lanza en CHONE (Manabí), y ya
-- atiende en Portoviejo (La Abuelita). Hasta hoy la base no sabía de ciudades:
-- un cliente de Chone habría visto en el menú del chat los locales de
-- Portoviejo, a una hora de camino, y un repartidor de Chone los pedidos de
-- allá. Las grandes empiezan por ahí —«¿dónde estás?»— antes de enseñar nada.
--
--   · `cities`: las ciudades donde atiende Umbani. Las crea el superadmin.
--   · `businesses.city_id`: la ciudad del local. ⚠️ SIN CIUDAD NO APARECE A
--     NINGÚN CLIENTE — así salen del menú, de una vez, los 15 locales de
--     muestra, que nunca tuvieron dirección.
--   · `customers.city_id`: la ciudad que ELIGIÓ el cliente. Solo se guarda
--     cuando él la elige: con una sola ciudad con locales se le enseña esa sin
--     preguntar y sin anotarla, para que el día que abra otra se le pregunte.
--   · `couriers.city_id`: el motorizado de Umbani solo ve y toma pedidos de los
--     locales de SU ciudad. El de la flota de un local no la necesita.
--
-- ⚠️ FALLA CERRADO: las funciones del menú SIN ciudad no devuelven ningún
-- local. Si algún camino del código se olvida de pasarla, el cliente ve una
-- lista vacía —se nota en seguida— en vez de los locales de otra ciudad, que
-- es justo el fallo que esto viene a cerrar y el que nadie notaría.
-- ============================================================================

create table if not exists public.cities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  province   text,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_cities_nombre on public.cities (lower(name));
alter table public.cities enable row level security;
revoke all on public.cities from anon, authenticated;

comment on table public.cities is
  'Ciudades donde atiende Umbani. Un local sin ciudad no aparece a los clientes.';

insert into public.cities (name, province, sort)
select v.name, v.province, v.sort
from (values ('Chone', 'Manabí', 1), ('Portoviejo', 'Manabí', 2)) as v(name, province, sort)
where not exists (select 1 from public.cities c where lower(c.name) = lower(v.name));

alter table public.businesses
  add column if not exists city_id uuid references public.cities(id) on delete set null;
create index if not exists idx_businesses_ciudad on public.businesses (city_id);
comment on column public.businesses.city_id is
  'Ciudad del local. Sin ella no aparece a ningún cliente (menú, búsqueda ni app).';

alter table public.customers
  add column if not exists city_id uuid references public.cities(id) on delete set null;
comment on column public.customers.city_id is
  'La ciudad que eligió el cliente. Solo se guarda cuando él la elige.';

alter table public.couriers
  add column if not exists city_id uuid references public.cities(id) on delete set null;
create index if not exists idx_couriers_ciudad on public.couriers (city_id);
comment on column public.couriers.city_id is
  'Ciudad del motorizado de Umbani: solo ve y toma pedidos de los locales de ella.';

-- Los dos locales de hoy fuera de los de muestra. Decisión del dueño
-- (2026-10-05): «Monster Pizza y La Abuelita también eran negocios de pruebas,
-- colócalos en Chone», la ciudad del lanzamiento. Los 15 de muestra se quedan
-- SIN ciudad: no aparecen a nadie.
update public.businesses
   set city_id = (select id from public.cities where lower(name) = 'chone')
 where slug in ('monster-pizza', 'la-abuelita') and city_id is null;


-- ── 1. Las categorías que tienen algo detrás, POR CIUDAD ─────────────────────
-- Una fila por ciudad y categoría: de la misma consulta salen las ciudades con
-- locales (para preguntar «¿en qué ciudad estás?») y las categorías de cada
-- una, sin una ida a la base de más.
drop function if exists public.marketplace_categories_disponibles();
create function public.marketplace_categories_disponibles()
returns table (
  city_id   uuid,
  city_name text,
  code      text,
  label     text,
  emoji     text,
  sort      integer,
  locales   bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select ci.id, ci.name, c.code, c.label, c.emoji, c.sort, count(distinct b.id) as locales
  from public.marketplace_categories c
  join public.marketplace_cajones_de_negocio v on v.category_id = c.id
  join public.businesses b on b.id = v.business_id
  join public.cities ci on ci.id = b.city_id
  where c.active
    and ci.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  group by ci.id, ci.name, ci.sort, c.code, c.label, c.emoji, c.sort
  having count(distinct b.id) > 0
  order by ci.sort, ci.name, c.sort, c.label;
$$;

revoke all on function public.marketplace_categories_disponibles()
  from public, anon, authenticated;
grant execute on function public.marketplace_categories_disponibles()
  to service_role;


-- ── 2. Los locales de una categoría EN UNA CIUDAD ────────────────────────────
drop function if exists public.marketplace_negocios_de_categoria(text);
create function public.marketplace_negocios_de_categoria(p_code text, p_city_id uuid)
returns table (
  id          uuid,
  slug        text,
  name        text,
  type        text,
  prep_min    integer,
  -- ¿Se le puede pedir algo AHORA? Falso solo si tiene carta y ninguna parte
  -- de ella está en su franja en este momento.
  con_carta   boolean,
  -- Desde qué hora vuelve a haber algo. Nulo si no se puede saber.
  carta_desde time
)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct b.id, b.slug, b.name, b.type,
         b.prep_time_minutes + coalesce(b.delivery_extra_minutes, 0),
         (
           not exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
           )
           or exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
               and public.producto_en_horario(
                 p.available_days, p.available_from, p.available_until)
           )
         ),
         (
           select min(p.available_from) from public.products p
           where p.business_id = b.id and p.active and p.available_from is not null
         )
  from public.businesses b
  join public.marketplace_cajones_de_negocio v on v.business_id = b.id
  join public.marketplace_categories c on c.id = v.category_id
  where c.code = p_code
    and c.active
    -- ⚠️ Sin ciudad, nada: `NULL = x` nunca es cierto. Falla cerrado a propósito.
    and b.city_id = p_city_id
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  order by b.name;
$$;

revoke all on function public.marketplace_negocios_de_categoria(text, uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_negocios_de_categoria(text, uuid)
  to service_role;


-- ── 3. Buscar locales EN UNA CIUDAD ──────────────────────────────────────────
-- La misma búsqueda de siempre (alias, carta, parecido y nombre); solo cambia
-- qué locales entran en `disponibles`.
drop function if exists public.marketplace_buscar_negocios(text, integer);
create function public.marketplace_buscar_negocios(
  p_query text,
  p_limite integer default 8,
  p_city_id uuid default null
)
returns table (
  id     uuid,
  slug   text,
  name   text,
  type   text,
  motivo text,
  orden  real
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with consulta as (
    select public.marketplace_normalizar_consulta(p_query) as texto
  ),
  disponibles as (
    select b.* from public.businesses b
    where b.active and b.suspended is not true
      and b.takes_orders and b.storefront_enabled
      -- ⚠️ Sin ciudad, nada (falla cerrado), igual que el menú.
      and b.city_id = p_city_id
  ),
  -- Capa 1: el alias manda, y por eso puntúa más alto que todo lo demás.
  por_alias as (
    select distinct d.id, d.slug, d.name, d.type, 'categoria'::text as motivo, 3.0::real as orden
    from consulta c
    join public.marketplace_search_aliases a
      on a.term = c.texto
      or a.term = any(string_to_array(c.texto, ' '))
    join public.marketplace_categories mc on mc.code = a.category_code
    join public.marketplace_cajones_de_negocio v on v.category_id = mc.id
    join disponibles d on d.id = v.business_id
  ),
  -- Capa 2: la carta del local menciona lo que pidió.
  por_texto as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'producto'::text as motivo,
           (2.0 + ts_rank(
              to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,'')),
              plainto_tsquery('spanish', c.texto)
           ))::real as orden
    from consulta c
    join public.products p
      on p.active
     and to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,''))
         @@ plainto_tsquery('spanish', c.texto)
    join disponibles d on d.id = p.business_id
    where c.texto <> ''
    order by d.id, orden desc
  ),
  -- Capa 3: se parece. Cubre «cebiche» contra «ceviche» y el dedazo.
  por_parecido as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'parecido'::text as motivo,
           s.parecido::real as orden
    from consulta c
    join public.products p on p.active
    cross join lateral (
      select max(extensions.similarity(palabra, c.texto)) as parecido
      from unnest(string_to_array(lower(p.name), ' ')) as palabra
    ) s
    join disponibles d on d.id = p.business_id
    where c.texto <> '' and s.parecido > 0.3
    order by d.id, orden desc
  ),
  -- Y el nombre del propio local: «Don Pepe» debe encontrar a Don Pepe.
  por_nombre as (
    select d.id, d.slug, d.name, d.type, 'local'::text as motivo,
           (1.0 + extensions.similarity(lower(d.name), c.texto))::real as orden
    from consulta c
    join disponibles d
      on extensions.similarity(lower(d.name), c.texto) > 0.3
    where c.texto <> ''
  ),
  todo as (
    select * from por_alias
    union all select * from por_texto
    union all select * from por_parecido
    union all select * from por_nombre
  ),
  mejor as (
    select distinct on (t.id) t.id, t.slug, t.name, t.type, t.motivo, t.orden
    from todo t
    order by t.id, t.orden desc
  )
  select m.id, m.slug, m.name, m.type, m.motivo, m.orden
  from mejor m
  order by m.orden desc, m.name
  limit greatest(coalesce(p_limite, 8), 1);
$$;

revoke all on function public.marketplace_buscar_negocios(text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_buscar_negocios(text, integer, uuid)
  to service_role;


-- ── 4. Los motorizados de Umbani, solo en SU ciudad ─────────────────────────
-- Las mismas tres puertas que la flota propia del local (2026-10-04):
-- ofrecer, tomar y asignar. A la de Umbani se le añade la ciudad.
create or replace function public.orders_courier_permitido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.couriers%rowtype;
  v_reparte text;
  v_flota boolean;
  v_ciudad uuid;
begin
  if new.courier_id is null or new.courier_id is not distinct from old.courier_id then
    return new;
  end if;
  select * into v_c from public.couriers where id = new.courier_id;
  select delivery_by, own_fleet, city_id into v_reparte, v_flota, v_ciudad
    from public.businesses where id = new.business_id;
  -- ⚠️ `coalesce(…, false)`: con un repartidor de Umbani `fleet_business_id`
  -- es NULL, y `NULL = x` da NULL — `not (… or NULL)` también, y el `if` lo
  -- trataría como «no rechazar». Cazado por la prueba antes de salir.
  if v_c.id is null or not v_c.active
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani' and v_ciudad = v_c.city_id, false)
             or coalesce(v_c.fleet_business_id = new.business_id and v_flota and v_reparte = 'local', false)) then
    raise exception using errcode = '42501',
      message = 'Ese repartidor no puede llevar pedidos de este local.';
  end if;
  return new;
end;
$$;

create or replace function public.courier_take_order(p_courier_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.couriers%rowtype;
  v_o public.orders%rowtype;
  v_reparte text;
  v_flota boolean;
  v_ciudad uuid;
  v_centavos integer;
begin
  select * into v_c from public.couriers where id = p_courier_id;
  if v_c.id is null or not v_c.active then
    return jsonb_build_object('result', 'inactivo');
  end if;

  select * into v_o from public.orders where id = p_order_id for update;
  if v_o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_o.courier_id is not null then
    return jsonb_build_object('result', case when v_o.courier_id = p_courier_id then 'ya_es_tuyo' else 'ya_tomado' end);
  end if;
  select delivery_by, own_fleet, city_id into v_reparte, v_flota, v_ciudad
    from public.businesses where id = v_o.business_id;
  if coalesce(v_o.fulfillment, 'delivery') <> 'delivery'
     -- Solo lo que el local YA ACEPTÓ: como en las grandes, nadie sale a por
     -- un pedido que el local todavía puede rechazar.
     or v_o.status not in ('confirmado', 'aceptado', 'preparacion')
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani' and v_ciudad = v_c.city_id, false)
             or coalesce(v_c.fleet_business_id = v_o.business_id and v_flota and v_reparte = 'local', false)) then
    return jsonb_build_object('result', 'no_disponible');
  end if;
  -- Con tarjeta ya pagado; sin pagar no sale (lo exige también la base).
  if v_o.payment_method = 'tarjeta' and v_o.payment_confirmed_at is null then
    return jsonb_build_object('result', 'no_disponible');
  end if;

  if coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar') then
    v_centavos := round(v_o.total * 100)::integer;
    if public.courier_cash_in_hand(p_courier_id) + v_centavos > v_c.cash_limit_cents then
      return jsonb_build_object('result', 'tope_de_efectivo',
        'tope_cents', v_c.cash_limit_cents, 'en_mano_cents', public.courier_cash_in_hand(p_courier_id));
    end if;
  end if;

  update public.orders
     set courier_id = p_courier_id, courier_assigned_at = now(), updated_at = now()
   where id = p_order_id;
  return jsonb_build_object('result', 'ok', 'order_id', p_order_id, 'business_id', v_o.business_id);
end;
$$;

revoke all on function public.courier_take_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.courier_take_order(uuid, uuid) to service_role;

create or replace function public.courier_orders(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with yo as (select * from public.couriers where id = p_courier_id and active),
  pedidos as (
    select o.*, b.name as local_nombre, b.address as local_direccion,
           b.latitude as local_lat, b.longitude as local_lng
    from public.orders o
    join public.businesses b on b.id = o.business_id
    join yo on true
    where coalesce(o.fulfillment, 'delivery') = 'delivery'
      and (
        (o.courier_id is null and o.status in ('confirmado', 'aceptado', 'preparacion')
          and (coalesce(yo.fleet_business_id is null and b.delivery_by = 'umbani' and b.city_id = yo.city_id, false)
               or coalesce(yo.fleet_business_id = o.business_id and b.own_fleet and b.delivery_by = 'local', false))
          and not (o.payment_method = 'tarjeta' and o.payment_confirmed_at is null))
        or (o.courier_id = yo.id and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado'))
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'numero', p.order_number,
    'estado', p.status,
    'mio', p.courier_id is not null,
    'totalCents', round(p.total * 100)::integer,
    'carreraCents', round(coalesce(p.shipping, 0) * 100)::integer,
    -- Efectivo = lo cobra él en la puerta; el resto ya está pagado.
    'cobrarEnEfectivo', coalesce(p.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar'),
    'recoger', jsonb_build_object('local', p.local_nombre, 'direccion', p.local_direccion,
                                  'lat', p.local_lat, 'lng', p.local_lng),
    'entregar', jsonb_build_object('cliente', p.contact_name, 'direccion', p.delivery_address,
                                   'referencia', p.delivery_reference, 'notas', p.delivery_courier_notes,
                                   'lat', p.delivery_latitude, 'lng', p.delivery_longitude)
  ) order by p.courier_id is null, p.created_at), '[]'::jsonb)
  from pedidos p
$$;

revoke all on function public.courier_orders(uuid) from public, anon, authenticated;
grant execute on function public.courier_orders(uuid) to service_role;
