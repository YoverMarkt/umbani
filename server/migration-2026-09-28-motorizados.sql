-- ============================================================================
-- LOS MOTORIZADOS: QUIÉN REPARTE, CUÁNTO EFECTIVO LLEVA Y SU LIQUIDACIÓN
--
-- Decisiones del dueño (2026-09-27, «como las grandes»):
--   · El motorizado de Umbani GUARDA el efectivo que cobra y liquida los lunes;
--     Umbani le paga al local. Su carrera es suya.
--   · Tope de efectivo: $150. Por encima, no toma pedidos en efectivo hasta
--     liquidar (así nadie acumula una deuda que no puede pagar).
--   · Si se le cae la comida, se le RETIENE la carrera de ese pedido; el local
--     cobra igual su comida.
--   · Si el local tiene su propia flota, sus repartidores se registran como
--     del local: la carrera es del local y Umbani solo liquida con él.
--
-- ⚠️ CONSTRUIDO Y APAGADO. `businesses.delivery_by` nace en 'local' para todos:
-- ningún pedido se le ofrece a un motorizado de Umbani hasta que el
-- superadmin lo cambie a 'umbani' en un local.
--
-- ⚠️ Los repartidores de Umbani no son de ningún local, así que NO llevan
-- `business_id` (llevan `fleet_business_id`, nulo = flota de Umbani) y su
-- liquidación va en `courier_settlements`, no en `settlements`. Mezclarlos
-- obligaría a un `business_id` nulo justo en las foráneas compuestas que
-- impiden cruzar dinero entre negocios.
-- ============================================================================

-- ── 1. Quién reparte en cada local ────────────────────────────────────────
alter table public.businesses
  add column if not exists delivery_by text not null default 'local';
alter table public.businesses drop constraint if exists businesses_delivery_by_check;
alter table public.businesses add constraint businesses_delivery_by_check
  check (delivery_by in ('local', 'umbani'));
comment on column public.businesses.delivery_by is
  'Quién lleva los pedidos: local (su gente, como hoy) o umbani (motorizados de la plataforma).';

-- ── 2. Los motorizados ────────────────────────────────────────────────────
create table if not exists public.couriers (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null,
  name              text not null,
  vehicle           text,
  -- NULO = motorizado de Umbani. Con valor = de la flota propia de ese local.
  fleet_business_id uuid references public.businesses(id) on delete cascade,
  active            boolean not null default true,
  -- «Estoy disponible»: lo cambia él desde su app.
  available         boolean not null default false,
  cash_limit_cents  integer not null default 15000,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint couriers_phone_check check (phone ~ '^\+?[0-9]{8,15}$'),
  constraint couriers_name_check check (char_length(btrim(name)) between 2 and 80),
  constraint couriers_cash_limit_check check (cash_limit_cents between 0 and 100000)
);

alter table public.couriers enable row level security;
revoke all on table public.couriers from anon, authenticated;
create unique index if not exists couriers_phone_unico on public.couriers (phone);
create index if not exists idx_couriers_flota on public.couriers (fleet_business_id);

-- ── 3. El pedido sabe quién lo lleva ──────────────────────────────────────
alter table public.orders
  add column if not exists courier_id uuid references public.couriers(id) on delete set null,
  add column if not exists courier_assigned_at timestamptz;
create index if not exists idx_orders_courier on public.orders (courier_id) where courier_id is not null;

-- ── 4. La liquidación de los motorizados ──────────────────────────────────
create table if not exists public.courier_settlements (
  id             uuid primary key default gen_random_uuid(),
  courier_id     uuid not null references public.couriers(id) on delete cascade,
  period_start   date not null,
  period_end     date not null,
  orders_count   integer not null default 0,
  -- Sus carreras (sin las retenidas).
  derecho_cents  integer not null default 0,
  -- El efectivo que cobró en la puerta y tiene él.
  en_mano_cents  integer not null default 0,
  arrastre_cents integer not null default 0,
  -- > 0: Umbani le paga · < 0: él le debe a Umbani (el efectivo de otros).
  neto_cents     integer not null,
  status         text not null,
  paid_at        timestamptz,
  reference      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint courier_settlements_status_check check (status in (
    'por_pagar', 'por_cobrar', 'en_cero', 'pagada', 'cobrada', 'compensada'
  )),
  constraint courier_settlements_semana_check check (
    extract(isodow from period_start) = 1 and period_end = period_start + 6
  ),
  constraint courier_settlements_cuadra check (neto_cents = derecho_cents - en_mano_cents + arrastre_cents),
  constraint courier_settlements_reference_check check (
    reference is null or char_length(btrim(reference)) between 3 and 120
  )
);

alter table public.courier_settlements enable row level security;
revoke all on table public.courier_settlements from anon, authenticated;
create unique index if not exists courier_settlements_una_por_semana
  on public.courier_settlements (courier_id, period_start);

-- ── 5. El libro sabe de la carrera retenida y de su liquidación ────────────
alter table public.order_ledger
  add column if not exists retenido boolean not null default false,
  add column if not exists retenido_motivo text,
  add column if not exists courier_settlement_id uuid references public.courier_settlements(id) on delete set null;
alter table public.order_ledger drop constraint if exists order_ledger_courier_fk;
alter table public.order_ledger add constraint order_ledger_courier_fk
  foreign key (courier_id) references public.couriers(id) on delete set null;
create index if not exists idx_order_ledger_courier_sin_liquidar
  on public.order_ledger (courier_id, sold_at)
  where courier_id is not null and courier_settlement_id is null;


-- ── 6. Ningún repartidor lleva el pedido de un local que no le toca ────────
--
-- En la base y no solo en la ruta: es la única puerta que no se salta. Uno de
-- Umbani solo lleva pedidos de locales que reparten con Umbani; uno de la
-- flota de un local, solo los de ese local. Y tiene que estar activo.
create or replace function public.orders_courier_permitido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.couriers%rowtype;
  v_reparte text;
begin
  if new.courier_id is null or new.courier_id is not distinct from old.courier_id then
    return new;
  end if;
  select * into v_c from public.couriers where id = new.courier_id;
  select delivery_by into v_reparte from public.businesses where id = new.business_id;
  -- ⚠️ `coalesce(…, false)`: con un repartidor de Umbani `fleet_business_id`
  -- es NULL, y `NULL = x` da NULL — `not (… or NULL)` también, y el `if` lo
  -- trataría como «no rechazar». Cazado por la prueba antes de salir.
  if v_c.id is null or not v_c.active
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani', false)
             or coalesce(v_c.fleet_business_id = new.business_id, false)) then
    raise exception using errcode = '42501',
      message = 'Ese repartidor no puede llevar pedidos de este local.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_courier_permitido on public.orders;
create trigger orders_courier_permitido
  before update of courier_id on public.orders
  for each row execute function public.orders_courier_permitido();


-- ── 7. El libro reconoce quién repartió ───────────────────────────────────
--
-- Recreada desde la de `migration-2026-09-28-cuentas-y-liquidacion-semanal`.
-- Lo nuevo: si lo llevó un motorizado de UMBANI, la carrera es suya
-- (`reparto_para = 'motorizado'`) y el efectivo lo tiene él
-- (`en_mano = 'motorizado'`). La transferencia sigue yendo al local y la
-- tarjeta a Umbani. Un repartidor de la flota del LOCAL no cambia nada: para
-- Umbani, lo llevó el local.
create or replace function public.sales_write_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metodo  text;
  v_courier uuid;
  v_umbani_reparte boolean := false;
  v_total   integer;
  v_umbani  integer;
  v_reparto integer;
begin
  if new.order_id is null
     or new.status <> 'completada'
     or new.sold_at < (public.liquidacion_semanal_desde()::timestamp at time zone 'America/Guayaquil') then
    return new;
  end if;

  select o.payment_method, o.courier_id, (c.id is not null and c.fleet_business_id is null)
    into v_metodo, v_courier, v_umbani_reparte
  from public.orders o
  left join public.couriers c on c.id = o.courier_id
  where o.id = new.order_id and o.business_id = new.business_id;

  v_total   := round(coalesce(new.total, 0) * 100)::integer;
  v_umbani  := round(coalesce(new.platform_markup, 0) * 100)::integer;
  v_reparto := round(coalesce(new.shipping, 0) * 100)::integer;

  insert into public.order_ledger (
    business_id, order_id, sale_id, kind, sold_at, payment_method,
    total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
    reparto_para, courier_id, en_mano
  ) values (
    new.business_id, new.order_id, new.id, 'venta', new.sold_at, v_metodo,
    v_total, v_total - v_umbani - v_reparto, v_reparto, v_umbani,
    case when v_metodo = 'tarjeta'
      then round(v_total * public.comision_payphone_bps() / 10000.0)::integer
      else 0 end,
    case when v_umbani_reparte then 'motorizado' else 'local' end,
    case when v_umbani_reparte then v_courier end,
    case
      when v_metodo = 'tarjeta' then 'umbani'
      when v_metodo = 'transferencia' then 'local'
      when v_umbani_reparte then 'motorizado'
      else 'local'
    end
  )
  on conflict (order_id, kind) do nothing;

  return new;
end;
$$;


-- ── 8. El efectivo que lleva encima ───────────────────────────────────────
--
-- Lo cobrado y aún sin liquidar, MÁS lo que va a cobrar en los pedidos en
-- efectivo que ya tomó y no ha entregado.
create or replace function public.courier_cash_in_hand(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((
      select sum(total_cents) from public.order_ledger
      where courier_id = p_courier_id and en_mano = 'motorizado' and courier_settlement_id is null
    ), 0)
    + coalesce((
      select sum(round(o.total * 100)) from public.orders o
      where o.courier_id = p_courier_id
        and coalesce(o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
        and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado')
    ), 0)
  )::integer
$$;

revoke all on function public.courier_cash_in_hand(uuid) from public, anon, authenticated;
grant execute on function public.courier_cash_in_hand(uuid) to service_role;


-- ── 9. Tomar un pedido ────────────────────────────────────────────────────
--
-- Atómico: dos motorizados tocando a la vez, uno se lo lleva y el otro lee
-- «ya lo tomó otro». Con efectivo, respeta el tope.
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
  select delivery_by into v_reparte from public.businesses where id = v_o.business_id;
  if coalesce(v_o.fulfillment, 'delivery') <> 'delivery'
     -- Solo lo que el local YA ACEPTÓ: como en las grandes, nadie sale a por
     -- un pedido que el local todavía puede rechazar.
     or v_o.status not in ('confirmado', 'aceptado', 'preparacion')
     or not (coalesce(v_c.fleet_business_id is null and v_reparte = 'umbani', false)
             or coalesce(v_c.fleet_business_id = v_o.business_id, false)) then
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


-- ── 10. Recogido y entregado: por la máquina de estados de siempre ─────────
--
-- `set_order_status` sigue siendo la única puerta: respeta el candado de la
-- checklist (no sale nada incompleto) y al entregar crea la venta —y con ella
-- el libro—. Aquí solo se comprueba que el pedido es DE ESTE motorizado.
create or replace function public.courier_advance_order(
  p_courier_id uuid, p_order_id uuid, p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
begin
  if p_status not in ('en_camino', 'completado') then
    raise exception using errcode = '22023', message = 'El motorizado solo marca «en camino» o «entregado».';
  end if;
  select * into v_o from public.orders where id = p_order_id;
  if v_o.id is null or v_o.courier_id is distinct from p_courier_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  return public.set_order_status(v_o.business_id, p_order_id, p_status);
end;
$$;

revoke all on function public.courier_advance_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.courier_advance_order(uuid, uuid, text) to service_role;


-- ── 11. Se le cayó la comida: se le retiene la carrera ─────────────────────
--
-- Decisión del dueño: responde quien la dejó caer. La carrera sale de su
-- liquidación; el local cobra su comida igual. Solo mientras no esté
-- liquidada: una semana cerrada no se reescribe.
create or replace function public.retain_courier_fee(p_order_id uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception using errcode = '22023', message = 'Escribe el motivo.';
  end if;
  update public.order_ledger
     set retenido = true, retenido_motivo = left(btrim(p_motivo), 300)
   where order_id = p_order_id and kind = 'venta'
     and reparto_para = 'motorizado' and courier_settlement_id is null and not retenido;
  get diagnostics v_filas = row_count;
  return jsonb_build_object('result', case when v_filas > 0 then 'retenida' else 'no_aplica' end);
end;
$$;

revoke all on function public.retain_courier_fee(uuid, text) from public, anon, authenticated;
grant execute on function public.retain_courier_fee(uuid, text) to service_role;


-- ── 12. El cierre semanal de los motorizados ──────────────────────────────
--
-- El mismo mecanismo que el de los locales: derecho (sus carreras, sin las
-- retenidas) − en mano (el efectivo que cobró) + lo que debía. Por
-- conjuntos, idempotente y con candado.
create or replace function public.close_weekly_courier_settlements(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin    date;
  v_hoy    date := (now() at time zone 'America/Guayaquil')::date;
  v_hasta  timestamptz;
  v_creadas integer;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'La semana empieza en lunes.';
  end if;
  v_fin := p_week_start + 7;
  if v_fin > v_hoy then
    raise exception using errcode = '22023', message = 'Esa semana todavía no terminó.';
  end if;
  if p_week_start < public.liquidacion_semanal_desde() then
    return jsonb_build_object('semana', p_week_start, 'creadas', 0, 'motivo', 'antes_del_corte');
  end if;

  perform pg_advisory_xact_lock(hashtext('close_weekly_courier_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  with libro as (
    select l.courier_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'motorizado' then l.total_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.courier_id is not null and l.courier_settlement_id is null and l.sold_at < v_hasta
    group by l.courier_id
  ),
  deuda as (
    select courier_id, sum(neto_cents)::integer as arrastre
    from public.courier_settlements
    where status = 'por_cobrar' and period_start < p_week_start
    group by courier_id
  ),
  base as (
    select coalesce(l.courier_id, d.courier_id) as courier_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l full join deuda d on d.courier_id = l.courier_id
  )
  insert into public.courier_settlements (
    courier_id, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, neto_cents, status
  )
  select b.courier_id, p_week_start, p_week_start + 6, b.pedidos,
         b.derecho, b.en_mano, b.arrastre, b.derecho - b.en_mano + b.arrastre,
         case when b.derecho - b.en_mano + b.arrastre > 0 then 'por_pagar'
              when b.derecho - b.en_mano + b.arrastre < 0 then 'por_cobrar'
              else 'en_cero' end
  from base b
  on conflict (courier_id, period_start) do nothing;
  get diagnostics v_creadas = row_count;

  update public.order_ledger l
     set courier_settlement_id = s.id
    from public.courier_settlements s
   where s.courier_id = l.courier_id and s.period_start = p_week_start
     and l.courier_settlement_id is null and l.sold_at < v_hasta;

  update public.courier_settlements s
     set status = 'compensada', updated_at = now()
   where s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from public.courier_settlements n
                 where n.courier_id = s.courier_id and n.period_start = p_week_start);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

revoke all on function public.close_weekly_courier_settlements(date) from public, anon, authenticated;
grant execute on function public.close_weekly_courier_settlements(date) to service_role;


-- ── 13. Marcar pagada o cobrada la liquidación de un motorizado ────────────
create or replace function public.mark_courier_settlement_paid(p_settlement_id uuid, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_status text;
begin
  if v_ref is null or char_length(v_ref) < 3 then
    raise exception using errcode = '22023', message = 'Escribe la referencia de la transferencia.';
  end if;
  update public.courier_settlements
     set status = case status when 'por_pagar' then 'pagada' else 'cobrada' end,
         paid_at = now(), reference = left(v_ref, 120), updated_at = now()
   where id = p_settlement_id and status in ('por_pagar', 'por_cobrar')
  returning status into v_status;
  if v_status is null then return jsonb_build_object('result', 'not_pending'); end if;
  return jsonb_build_object('result', 'updated', 'status', v_status);
end;
$$;

revoke all on function public.mark_courier_settlement_paid(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_courier_settlement_paid(uuid, text) to service_role;


-- ── 14. Lo que la app del motorizado necesita ver ─────────────────────────
--
-- Los pedidos que puede tomar (aceptados por el local, a domicilio, sin
-- repartidor, de un local que le toca) y los suyos en curso. Con dónde
-- recoger y dónde entregar; nunca el teléfono del local.
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
               or coalesce(yo.fleet_business_id = o.business_id, false))
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

-- Su semana EN CURSO (lo aún sin liquidar) y el efectivo que lleva.
create or replace function public.courier_balance(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pedidos', count(*) filter (where l.kind = 'venta'),
    'carrerasCents', coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0),
    'retenidasCents', coalesce(sum(case when l.retenido then l.reparto_cents else 0 end), 0),
    'efectivoCobradoCents', coalesce(sum(case when l.en_mano = 'motorizado' then l.total_cents else 0 end), 0),
    'deAntesCents', coalesce((select sum(neto_cents) from public.courier_settlements
                              where courier_id = p_courier_id and status = 'por_cobrar'), 0),
    'efectivoEncimaCents', public.courier_cash_in_hand(p_courier_id)
  )
  from public.order_ledger l
  where l.courier_id = p_courier_id and l.courier_settlement_id is null
$$;

revoke all on function public.courier_balance(uuid) from public, anon, authenticated;
grant execute on function public.courier_balance(uuid) to service_role;
