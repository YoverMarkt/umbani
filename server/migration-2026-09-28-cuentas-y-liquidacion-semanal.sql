-- ============================================================================
-- LAS CUENTAS DE CADA UNO Y EL CIERRE SEMANAL (como las grandes)
--
-- Decisión del dueño (2026-09-27). Con la tarjeta, el dinero entra en la
-- cuenta de Umbani y hay que LIQUIDAR a cada local; con el efectivo y la
-- transferencia, el dinero lo tiene el local y es él quien debe la comisión.
-- Un solo mecanismo para los dos, y para el motorizado cuando exista:
--
--   Cada pedido ENTREGADO registra a qué tiene DERECHO cada uno (el local, sus
--   productos; quien reparte, la carrera; Umbani, su comisión) y QUIÉN TIENE
--   EL DINERO EN LA MANO (tarjeta → Umbani; efectivo o transferencia → el
--   local). Saldo = derecho − en mano. Cada lunes se cierra la semana: al que
--   tiene saldo a favor se le paga; al que debe, se le descuenta de lo
--   siguiente o se le cobra.
--
--   Invariante, que la base comprueba en CADA pedido:
--     local + reparto + Umbani = lo que pagó el cliente.
--
-- ⚠️ EL CORTE: lunes 2026-09-28, hora de Ecuador. Lo vendido ANTES se sigue
-- cobrando en la factura mensual de septiembre, como siempre; lo vendido
-- DESDE el corte va al libro y a la liquidación semanal. `settle_month_commission`
-- se detiene en el corte: sin ese tope, la comisión se cobraría dos veces.
--
-- ⚠️ Facturación queda para la CUOTA mensual ($25 por estar en Umbani). Si el
-- local tiene saldo a favor, la cuota pendiente se descuenta del depósito,
-- como hacen las grandes; si no, se cobra aparte.
-- ============================================================================


-- ── 1. El corte, escrito en un solo sitio ─────────────────────────────────
create or replace function public.liquidacion_semanal_desde()
returns date
-- `stable` y no `immutable`: una inmutable se evalúa al PLANIFICAR y quedaría
-- congelada dentro de los planes guardados de las funciones que la usan.
language sql
stable
set search_path = public, pg_temp
as $$
  select date '2026-09-28'
$$;

comment on function public.liquidacion_semanal_desde() is
  'Desde este lunes (hora EC) la comisión se liquida por semana; antes, en la factura mensual.';


-- ── 2. Lo que cobra PayPhone, en puntos básicos (575 = 5,75 %) ────────────
--
-- Es una ESTIMACIÓN para enseñarle a Umbani lo que le queda: PayPhone no la
-- manda al confirmar. Se negocia con PayPhone, así que vive en
-- `server_settings` (`payphone_fee_bps`) y no en el código.
create or replace function public.comision_payphone_bps()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select btrim(value)::integer
    from public.server_settings
    where key = 'payphone_fee_bps' and btrim(value) ~ '^[0-9]{1,4}$'
  ), 575)
$$;

revoke all on function public.comision_payphone_bps() from public, anon, authenticated;
grant execute on function public.comision_payphone_bps() to service_role;


-- ── 3. Las liquidaciones de cada semana ───────────────────────────────────
--
-- Una por local y semana (lunes a domingo, hora EC). `party` y `courier_id`
-- existen desde hoy para el motorizado: su liquidación será otra fila igual.
create table if not exists public.settlements (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  party          text not null default 'local',
  courier_id     uuid,
  period_start   date not null,
  period_end     date not null,
  orders_count   integer not null default 0,
  -- Lo que le correspondía (sus productos, y la carrera si reparte él).
  derecho_cents  integer not null default 0,
  -- Lo que ya tenía en la mano (efectivo y transferencias que cobró él).
  en_mano_cents  integer not null default 0,
  -- Lo que debía de semanas anteriores y no pagó: se compensa aquí.
  arrastre_cents integer not null default 0,
  -- La factura mensual pendiente que se descontó de este depósito.
  cuota_cents    integer not null default 0,
  billing_id     uuid,
  -- > 0: Umbani le paga · < 0: el local le debe a Umbani.
  neto_cents     integer not null,
  status         text not null,
  paid_at        timestamptz,
  reference      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint settlements_party_check check (party in ('local', 'motorizado')),
  constraint settlements_status_check check (status in (
    'por_pagar', 'por_cobrar', 'en_cero', 'pagada', 'cobrada', 'compensada'
  )),
  constraint settlements_semana_check check (
    extract(isodow from period_start) = 1 and period_end = period_start + 6
  ),
  -- El neto no se escribe: se deduce. Si alguien lo tocara a mano, no cuadra.
  constraint settlements_cuadra check (
    neto_cents = derecho_cents - en_mano_cents + arrastre_cents - cuota_cents
  ),
  constraint settlements_reference_check check (
    reference is null or char_length(btrim(reference)) between 3 and 120
  )
);

alter table public.settlements enable row level security;
revoke all on table public.settlements from anon, authenticated;

-- Una liquidación por local y semana: cerrar dos veces no duplica nada.
create unique index if not exists settlements_una_por_semana
  on public.settlements (business_id, party, period_start)
  where courier_id is null;
-- Destino de foránea compuesta: el libro no puede colgarse de la liquidación
-- de OTRO negocio.
create unique index if not exists uq_settlements_id_business
  on public.settlements (id, business_id);
create index if not exists idx_settlements_pendientes
  on public.settlements (status, period_start)
  where status in ('por_pagar', 'por_cobrar');


-- ── 4. El libro de cada pedido ────────────────────────────────────────────
--
-- Nace cuando el pedido se ENTREGA (con su venta): un pedido cancelado nunca
-- es dinero de nadie. Todo en centavos enteros, y el del local se deduce
-- RESTANDO del total (`total − Umbani − reparto`), como en las tres bolsas:
-- así cuadra sin preguntar el modo de margen.
create table if not exists public.order_ledger (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  order_id           uuid not null,
  sale_id            uuid,
  -- `reverso`: la venta se anuló DESPUÉS de liquidarla; resta en la siguiente.
  kind               text not null default 'venta',
  sold_at            timestamptz not null,
  payment_method     text,
  total_cents        integer not null,
  local_cents        integer not null,
  reparto_cents      integer not null,
  umbani_cents       integer not null,
  -- Lo que se estima que cobra PayPhone (solo tarjeta). Es costo de Umbani:
  -- NO se le descuenta al local, y por eso no entra en el invariante.
  provider_fee_cents integer not null default 0,
  -- Hoy reparte el local. Con motorizados de Umbani: 'motorizado' + courier_id.
  reparto_para       text not null default 'local',
  courier_id         uuid,
  en_mano            text not null,
  settlement_id      uuid,
  created_at         timestamptz not null default now(),

  constraint order_ledger_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint order_ledger_settlement_fk foreign key (settlement_id, business_id)
    references public.settlements (id, business_id) on delete set null (settlement_id),
  constraint order_ledger_kind_check check (kind in ('venta', 'reverso')),
  constraint order_ledger_reparto_para_check check (reparto_para in ('local', 'motorizado')),
  constraint order_ledger_en_mano_check check (en_mano in ('umbani', 'local', 'motorizado')),
  -- ⚠️ EL INVARIANTE. Si algún día no cuadra, la venta no se registra.
  constraint order_ledger_cuadra check (local_cents + reparto_cents + umbani_cents = total_cents),
  constraint order_ledger_signo check (
    (kind = 'venta'   and total_cents >= 0 and local_cents >= 0 and reparto_cents >= 0 and umbani_cents >= 0)
    or (kind = 'reverso' and total_cents <= 0 and local_cents <= 0 and reparto_cents <= 0 and umbani_cents <= 0)
  )
);

alter table public.order_ledger enable row level security;
revoke all on table public.order_ledger from anon, authenticated;

create unique index if not exists order_ledger_uno_por_pedido
  on public.order_ledger (order_id, kind);
create index if not exists idx_order_ledger_biz_sold
  on public.order_ledger (business_id, sold_at desc);
create index if not exists idx_order_ledger_sin_liquidar
  on public.order_ledger (business_id, sold_at)
  where settlement_id is null;

comment on table public.order_ledger is
  'A qué tiene derecho cada uno por pedido entregado y quién tiene el dinero. Centavos; cuadra siempre.';


-- ── 5. Al ENTREGARSE, el pedido escribe su libro ──────────────────────────
--
-- Se engancha a `sales` (la venta nace al entregar, en
-- `crear_venta_desde_pedido`) con un disparador, sin recrear las funciones del
-- dinero: el mismo criterio que `orders_stamp_pricing`. Cubre cualquier camino
-- que cree una venta desde un pedido.
--
-- ⚠️ Falla CERRADO a propósito: si el reparto no cuadra, la venta no se
-- registra y el dueño ve el error. Un pedido entregado sin su libro sería
-- dinero que nadie liquida nunca.
create or replace function public.sales_write_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metodo  text;
  v_total   integer;
  v_umbani  integer;
  v_reparto integer;
begin
  if new.order_id is null
     or new.status <> 'completada'
     or new.sold_at < (public.liquidacion_semanal_desde()::timestamp at time zone 'America/Guayaquil') then
    return new;
  end if;

  select payment_method into v_metodo
  from public.orders
  where id = new.order_id and business_id = new.business_id;

  v_total   := round(coalesce(new.total, 0) * 100)::integer;
  v_umbani  := round(coalesce(new.platform_markup, 0) * 100)::integer;
  v_reparto := round(coalesce(new.shipping, 0) * 100)::integer;

  insert into public.order_ledger (
    business_id, order_id, sale_id, kind, sold_at, payment_method,
    total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
    reparto_para, en_mano
  ) values (
    new.business_id, new.order_id, new.id, 'venta', new.sold_at, v_metodo,
    v_total, v_total - v_umbani - v_reparto, v_reparto, v_umbani,
    case when v_metodo = 'tarjeta'
      then round(v_total * public.comision_payphone_bps() / 10000.0)::integer
      else 0 end,
    'local',
    case when v_metodo = 'tarjeta' then 'umbani' else 'local' end
  )
  on conflict (order_id, kind) do nothing;

  return new;
end;
$$;

drop trigger if exists sales_write_ledger on public.sales;
create trigger sales_write_ledger
  after insert on public.sales
  for each row execute function public.sales_write_ledger();


-- ── 6. Venta anulada: fuera del libro, o restada en la siguiente ──────────
--
-- Sin liquidar todavía: la fila se borra y ese pedido no cuenta. Ya
-- liquidada: una semana cerrada no se reescribe jamás (el mismo criterio que
-- el mes `paid`), así que se escribe un REVERSO que resta en la próxima.
create or replace function public.sales_void_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.order_id is null
     or old.status is not distinct from new.status
     or old.status <> 'completada' or new.status <> 'anulada' then
    return new;
  end if;

  delete from public.order_ledger
  where order_id = new.order_id and kind = 'venta' and settlement_id is null;

  if not found then
    insert into public.order_ledger (
      business_id, order_id, sale_id, kind, sold_at, payment_method,
      total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
      reparto_para, courier_id, en_mano
    )
    select business_id, order_id, sale_id, 'reverso', now(), payment_method,
           -total_cents, -local_cents, -reparto_cents, -umbani_cents, -provider_fee_cents,
           reparto_para, courier_id, en_mano
    from public.order_ledger
    where order_id = new.order_id and kind = 'venta'
    on conflict (order_id, kind) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists sales_void_ledger on public.sales;
create trigger sales_void_ledger
  after update of status on public.sales
  for each row execute function public.sales_void_ledger();


-- ── 7. El cierre de la semana ─────────────────────────────────────────────
--
-- Una operación por CONJUNTOS (ver «Pensado para ciudades grandes»): nada de
-- un bucle por local. Idempotente: cerrar otra vez la misma semana no crea
-- nada, y dos servidores a la vez no chocan (candado de transacción).
--
-- Entra TODO lo sin liquidar hasta el domingo de esa semana, no solo lo de
-- esa semana: nada puede quedarse fuera por haber llegado tarde.
create or replace function public.close_weekly_settlements(
  p_week_start date
)
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

  perform pg_advisory_xact_lock(hashtext('close_weekly_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  create temp table if not exists tmp_cierre (
    business_id uuid primary key,
    pedidos integer, derecho integer, en_mano integer,
    arrastre integer, cuota integer, billing_id uuid
  ) on commit drop;
  truncate pg_temp.tmp_cierre;

  insert into pg_temp.tmp_cierre (business_id, pedidos, derecho, en_mano, arrastre, cuota, billing_id)
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'local' then l.total_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.settlement_id is null and l.sold_at < v_hasta
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null
      and s.status = 'por_cobrar' and s.period_start < p_week_start
    group by s.business_id
  ),
  base as (
    select coalesce(l.business_id, d.business_id) as business_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l
    full join deuda d on d.business_id = l.business_id
  ),
  -- La factura más vieja pendiente de cada local (cuota + la comisión de los
  -- meses anteriores al corte). Solo se descuenta si el saldo la cubre ENTERA.
  factura as (
    select distinct on (b.business_id)
           b.business_id, b.id as billing_id,
           round((coalesce(b.amount, 0) + coalesce(b.commission_amount, 0)) * 100)::integer as cents
    from public.billing b
    where b.status in ('pending', 'overdue') and b.period_start <= p_week_start
    order by b.business_id, b.period_start
  )
  select x.business_id, x.pedidos, x.derecho, x.en_mano, x.arrastre,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.cents else 0 end,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.billing_id end
  from base x
  left join factura f on f.business_id = x.business_id
  -- Ya liquidado esa semana: no se toca (idempotencia).
  where not exists (
    select 1 from public.settlements s
    where s.business_id = x.business_id and s.party = 'local'
      and s.courier_id is null and s.period_start = p_week_start
  );

  insert into public.settlements (
    business_id, party, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, cuota_cents, billing_id,
    neto_cents, status
  )
  select t.business_id, 'local', p_week_start, p_week_start + 6, t.pedidos,
         t.derecho, t.en_mano, t.arrastre, t.cuota, t.billing_id,
         t.derecho - t.en_mano + t.arrastre - t.cuota,
         case
           when t.derecho - t.en_mano + t.arrastre - t.cuota > 0 then 'por_pagar'
           when t.derecho - t.en_mano + t.arrastre - t.cuota < 0 then 'por_cobrar'
           else 'en_cero'
         end
  from pg_temp.tmp_cierre t
  on conflict do nothing;
  get diagnostics v_creadas = row_count;

  -- Cada pedido se liquida UNA vez.
  update public.order_ledger l
     set settlement_id = s.id
    from public.settlements s
   where s.business_id = l.business_id and s.party = 'local' and s.courier_id is null
     and s.period_start = p_week_start
     and l.settlement_id is null and l.sold_at < v_hasta
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = l.business_id);

  -- La deuda anterior ya viaja en el arrastre de esta semana.
  update public.settlements s
     set status = 'compensada', updated_at = now()
   where s.party = 'local' and s.courier_id is null
     and s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = s.business_id);

  -- La factura descontada queda pagada, con su rastro.
  update public.billing b
     set status = 'paid', paid_at = now(),
         notes = left(coalesce(nullif(btrim(b.notes), '') || ' · ', '')
           || 'Descontada de la liquidación de la semana del ' || to_char(p_week_start, 'DD/MM/YYYY'), 500)
   where b.id in (select billing_id from pg_temp.tmp_cierre where billing_id is not null);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

revoke all on function public.close_weekly_settlements(date) from public, anon, authenticated;
grant execute on function public.close_weekly_settlements(date) to service_role;


-- ── 8. Marcar pagada (Umbani al local) o cobrada (el local a Umbani) ──────
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


-- ── 9. El saldo EN CURSO de cada local (lo aún sin liquidar) ──────────────
create or replace function public.settlement_balances(
  p_business_id uuid default null
)
returns table (
  business_id      uuid,
  business_name    text,
  pedidos          integer,
  pedidos_tarjeta  integer,
  derecho_cents    integer,
  en_mano_cents    integer,
  arrastre_cents   integer,
  neto_cents       integer,
  umbani_cents     integer,
  payphone_cents   integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           count(*) filter (where l.kind = 'venta' and l.payment_method = 'tarjeta')::integer as pedidos_tarjeta,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'local' then l.total_cents else 0 end), 0)::integer as en_mano,
           coalesce(sum(l.umbani_cents), 0)::integer as umbani,
           coalesce(sum(l.provider_fee_cents), 0)::integer as payphone
    from public.order_ledger l
    where l.settlement_id is null
      and (p_business_id is null or l.business_id = p_business_id)
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null and s.status = 'por_cobrar'
      and (p_business_id is null or s.business_id = p_business_id)
    group by s.business_id
  )
  select coalesce(l.business_id, d.business_id), b.name,
         coalesce(l.pedidos, 0), coalesce(l.pedidos_tarjeta, 0),
         coalesce(l.derecho, 0), coalesce(l.en_mano, 0), coalesce(d.arrastre, 0),
         coalesce(l.derecho, 0) - coalesce(l.en_mano, 0) + coalesce(d.arrastre, 0),
         coalesce(l.umbani, 0), coalesce(l.payphone, 0)
  from libro l
  full join deuda d on d.business_id = l.business_id
  join public.businesses b on b.id = coalesce(l.business_id, d.business_id)
  order by 8 desc;
$$;

revoke all on function public.settlement_balances(uuid) from public, anon, authenticated;
grant execute on function public.settlement_balances(uuid) to service_role;


-- ── 10. La factura mensual deja de cobrar la comisión desde el corte ──────
--
-- Copiada ENTERA de la vigente (`schema.sql`). Cambia una cosa: el resumen
-- se pide hasta `least(fin de mes, corte)`. La cuota (`amount`) no se toca.
create or replace function public.settle_month_commission(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin       date;
  -- Hasta dónde cobra el MES: desde el corte, la comisión se liquida por
  -- semana (`order_ledger`). Sin este tope se cobraría dos veces.
  v_hasta     date;
  v_afectadas integer;
  v_total     numeric(10,2);
  v_pagadas   integer;
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El cierre va sobre el primer día de un mes.';
  end if;

  v_fin := (p_period_start + interval '1 month')::date;
  v_hasta := least(v_fin, public.liquidacion_semanal_desde());

  -- Cuántas facturas de ese mes están pagadas y por tanto NO se tocan. Se
  -- cuenta ANTES de escribir para poder informarlo: si un mes se cierra tarde
  -- y ya se cobró, el superadmin tiene que enterarse en vez de creer que
  -- entró todo.
  select count(*) into v_pagadas
  from public.billing
  where period_start = p_period_start
    and status = 'paid'
    and exists (
      select 1 from public.platform_markup_summary(p_period_start, v_hasta, business_id)
    );

  -- UNA operación: calcula, actualiza lo que existe y crea lo que falta.
  --
  -- `insert ... on conflict do update` en vez de leer-y-escribir porque con
  -- dos instancias del servidor lo segundo es una carrera: las dos leerían
  -- «no hay factura» y las dos insertarían.
  with resumen as (
    select * from public.platform_markup_summary(p_period_start, v_hasta, null)
  )
  insert into public.billing (
    business_id, amount, currency, period_start, period_end,
    status, commission_amount, commission_orders, commission_closed_at
  )
  select
    r.business_id,
    -- Sin cuota conocida la factura nace en 0 y solo lleva comisión: es
    -- preferible a que la comisión de ese local no se facture nunca.
    coalesce(b.monthly_rate, 0),
    'USD',
    p_period_start,
    (v_fin - interval '1 day')::date,
    'pending',
    r.margen,
    r.pedidos,
    now()
  from resumen r
  join public.businesses b on b.id = r.business_id
  on conflict (business_id, period_start) do update
  set commission_amount    = excluded.commission_amount,
      commission_orders    = excluded.commission_orders,
      commission_closed_at = now()
  -- ⚠️ Un mes ya pagado NO se reescribe: si una venta se anula después de
  -- liquidar, se descuenta del mes siguiente. Una factura emitida es un hecho.
  where public.billing.status <> 'paid';

  get diagnostics v_afectadas = row_count;

  select coalesce(sum(commission_amount), 0) into v_total
  from public.billing
  where period_start = p_period_start;

  return jsonb_build_object(
    'periodo',            p_period_start,
    'facturas_afectadas', v_afectadas,
    'comision_total',     v_total,
    'ya_pagadas',         v_pagadas
  );
end;
$$;
