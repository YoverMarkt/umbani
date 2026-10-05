-- ============================================================================
-- LOS REPARTIDORES PROPIOS SE ENCIENDEN LOCAL POR LOCAL
--
-- Decisión del dueño (2026-10-02, al volver de vender): «si voy a vender a un
-- local y me dice que tiene su flota, solo le activamos a ellos». Como las
-- grandes: Uber Eats, DoorDash o PedidosYa deciden local por local, al firmar,
-- si reparte la plataforma o reparte el local.
--
-- Hasta hoy era UN interruptor para todos (`flota_del_local` en Ajustes del
-- superadmin), y además vivía solo en la API del panel: con él apagado, un
-- repartidor YA registrado seguía viendo y tomando los pedidos de su local
-- —`courier_orders` y `courier_take_order` no lo miraban— mientras el local,
-- con la pestaña escondida, no podía desactivarlo. Apagado no era apagado.
--
-- Ahora la regla vive en la base, en las TRES puertas por las que un
-- repartidor de la flota de un local llega a un pedido:
--   · `courier_orders`             — lo que su app le ofrece;
--   · `courier_take_order`         — tomarlo;
--   · `orders_courier_permitido`   — asignarlo, también a mano.
-- Las tres exigen lo mismo: que ESE local tenga `own_fleet` encendido y
-- reparta él mismo (`delivery_by = 'local'`). Con «Quién reparte: Umbani»,
-- reparten los de Umbani y nadie más.
--
-- ⚠️ Lo que ya lleva, lo termina: el pedido que un repartidor tomó sigue en su
-- lista hasta entregarlo aunque se apague la flota a mitad de camino. Apagar
-- no puede dejar una comida en la calle sin nadie que pueda marcarla.
--
-- ⚠️ Nace APAGADO en todos los locales. Ningún pedido cambia de manos al
-- aplicarla: hoy no hay ningún repartidor de flota en producción.
-- ============================================================================

alter table public.businesses
  add column if not exists own_fleet boolean not null default false;

comment on column public.businesses.own_fleet is
  'Repartidores propios: el local registra a los suyos y solo ellos llevan sus pedidos. Solo cuenta con delivery_by = local. Lo enciende el superadmin.';

-- El interruptor global que esto sustituye. Solo existió en el staging.
delete from public.server_settings where key = 'flota_del_local';


-- ── 1. Asignar: ningún repartidor lleva el pedido de un local que no le toca ──
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
begin
  if new.courier_id is null or new.courier_id is not distinct from old.courier_id then
    return new;
  end if;
  select * into v_c from public.couriers where id = new.courier_id;
  select delivery_by, own_fleet into v_reparte, v_flota from public.businesses where id = new.business_id;
  -- ⚠️ `coalesce(…, false)`: con un repartidor de Umbani `fleet_business_id`
  -- es NULL, y `NULL = x` da NULL — `not (… or NULL)` también, y el `if` lo
  -- trataría como «no rechazar». Cazado por la prueba antes de salir.
  if v_c.id is null or not v_c.active
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani', false)
             or coalesce(v_c.fleet_business_id = new.business_id and v_flota and v_reparte = 'local', false)) then
    raise exception using errcode = '42501',
      message = 'Ese repartidor no puede llevar pedidos de este local.';
  end if;
  return new;
end;
$$;


-- ── 2. Tomar un pedido ────────────────────────────────────────────────────
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
  select delivery_by, own_fleet into v_reparte, v_flota from public.businesses where id = v_o.business_id;
  if coalesce(v_o.fulfillment, 'delivery') <> 'delivery'
     -- Solo lo que el local YA ACEPTÓ: como en las grandes, nadie sale a por
     -- un pedido que el local todavía puede rechazar.
     or v_o.status not in ('confirmado', 'aceptado', 'preparacion')
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani', false)
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


-- ── 3. Lo que la app del motorizado le ofrece ─────────────────────────────
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
          and (coalesce(yo.fleet_business_id is null and b.delivery_by = 'umbani', false)
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
