-- ============================================================================
-- QUE PAGUE QUIEN TUVO LA CULPA — fase 2 de las incidencias, parte 3 (2026-10-12)
--
-- Plan aprobado por el dueño (2026-10-12), «como las grandes»: Uber Eats y
-- DoorDash le descuentan al restaurante, en su pago semanal, lo que se
-- devolvió por un error suyo. Hasta hoy, el saldo que recibía el cliente lo
-- ponía SIEMPRE Umbani, y si la comida se perdía antes de entregar, la perdía
-- el local.
--
--   · PRIMERO EL CLIENTE (partes 1 y 2): su saldo ya está. Al CONFIRMAR el
--     superadmin quién responde, la liquidación del lunes de cada uno se
--     ajusta sola, una vez, y queda en el registro de dinero.
--   · Reclamos del cliente (faltó, vino mal, no llegó): paga el responsable
--     lo que se le devolvió al cliente MENOS la comisión de Umbani («Umbani
--     devuelve la suya»). El local; el repartidor de Umbani o de una
--     cooperativa (decisión del dueño: a él, no a su cooperativa); el de la
--     flota del propio local lo paga el local; Umbani lo absorbe.
--   · «No llegó» en EFECTIVO: el libro anotó que quien entregó COBRÓ ese
--     efectivo. Primero se deshace ese cobro que no ocurrió y después paga el
--     responsable la comida y la carrera. Así Umbani queda neutro y, si el
--     responsable es quien dijo haber cobrado, termina pagando justo la comida.
--   · Lo que pasa ANTES de entregar (la comida se cayó, el repartidor no
--     apareció, un accidente, el cliente no estaba): al local se le reconoce
--     su comida y paga quien responde; accidente y cliente ausente los pone
--     Umbani (decisión del dueño) y el cliente ausente queda bloqueado.
--   · Los ajustes se suman al cierre del lunes (y a los saldos en curso). Si
--     alguien queda debiendo, pasa a la semana siguiente como siempre.
-- ============================================================================


-- ── 1. Los ajustes ───────────────────────────────────────────────────────────
-- Con signo: + a favor de quien lo recibe, − se le cobra. Uno por incidencia,
-- parte y concepto. Lo escribe SOLO la base al resolver.

-- Destino de foránea compuesta: un ajuste no puede colgarse de la incidencia
-- de OTRO negocio (lo vigila verificar-fronteras.sql).
create unique index if not exists uq_order_incidents_id_business
  on public.order_incidents (id, business_id);

create table if not exists public.settlement_adjustments (
  id                    uuid primary key default gen_random_uuid(),
  incident_id           uuid not null,
  order_id              uuid not null,
  business_id           uuid not null references public.businesses(id) on delete cascade,
  party                 text not null,
  courier_id            uuid references public.couriers(id) on delete cascade,
  cents                 integer not null,
  concepto              text not null,
  created_at            timestamptz not null default now(),
  settlement_id         uuid,
  courier_settlement_id uuid references public.courier_settlements(id) on delete set null,

  constraint settlement_adjustments_incident_fk foreign key (incident_id, business_id)
    references public.order_incidents (id, business_id) on delete cascade,
  constraint settlement_adjustments_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  -- La liquidación de OTRO negocio no puede llevarse el ajuste de este.
  constraint settlement_adjustments_settlement_fk foreign key (settlement_id, business_id)
    references public.settlements (id, business_id) on delete set null (settlement_id),
  constraint settlement_adjustments_party_check check (party in ('local', 'motorizado')),
  constraint settlement_adjustments_quien_check check (
    (party = 'local' and courier_id is null and courier_settlement_id is null)
    or (party = 'motorizado' and courier_id is not null and settlement_id is null)
  ),
  constraint settlement_adjustments_cents_check check (cents <> 0 and abs(cents) <= 10000000),
  constraint settlement_adjustments_concepto_check check (concepto in (
    'reclamo',            -- lo que se le devolvió al cliente, menos la comisión de Umbani
    'no_cobro',           -- «no llegó» en efectivo: no cobró lo que el libro dice que cobró
    'comida_reconocida',  -- la comida que el local perdió antes de entregar
    'comida_cobrada'      -- esa comida, al repartidor que respondía
  ))
);

create unique index if not exists settlement_adjustments_una_vez
  on public.settlement_adjustments (incident_id, party, concepto);
create index if not exists idx_settlement_adjustments_local_sin_liquidar
  on public.settlement_adjustments (business_id, created_at)
  where party = 'local' and settlement_id is null;
create index if not exists idx_settlement_adjustments_motorizado_sin_liquidar
  on public.settlement_adjustments (courier_id, created_at)
  where party = 'motorizado' and courier_settlement_id is null;

alter table public.settlement_adjustments enable row level security;
revoke all on table public.settlement_adjustments from anon, authenticated;
comment on table public.settlement_adjustments is
  'Lo que se le reconoce (+) o se le cobra (−) a un local o repartidor por una incidencia resuelta. Lo suma el cierre del lunes.';


-- ── 2. Las liquidaciones cuentan los ajustes ────────────────────────────────
alter table public.settlements
  add column if not exists ajustes_cents integer not null default 0;
alter table public.settlements drop constraint if exists settlements_cuadra;
alter table public.settlements add constraint settlements_cuadra check (
  neto_cents = derecho_cents - en_mano_cents + arrastre_cents - cuota_cents + ajustes_cents
);

alter table public.courier_settlements
  add column if not exists ajustes_cents integer not null default 0;
alter table public.courier_settlements drop constraint if exists courier_settlements_cuadra;
alter table public.courier_settlements add constraint courier_settlements_cuadra check (
  neto_cents = derecho_cents - en_mano_cents + arrastre_cents + ajustes_cents
);


-- ── 3. El efecto de resolver: lo que se va a ajustar, sin escribir nada ─────
-- Lo usa `aplicar_ajustes_de_la_incidencia` al resolver y el superadmin ANTES
-- de confirmar: el número que ve es el mismo que se aplica.
create or replace function public.efecto_de_la_incidencia(
  p_incident_id uuid, p_responsible text, p_compensation_cents integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.order_incidents%rowtype;
  v_o public.orders%rowtype;
  v_c public.couriers%rowtype;
  v_libro public.order_ledger%rowtype;
  -- A quién se le cobra: 'local', 'motorizado' o nadie (Umbani o el cliente).
  v_cobra text;
  v_courier uuid;
  v_s integer := greatest(coalesce(p_compensation_cents, 0), 0);
  v_l integer;
  v_u integer;
  v_r integer;
  v_x integer;
  -- La parte de la comisión de Umbani en lo devuelto: proporcional (2026-10-12).
  v_comision integer;
  v_efectivo boolean;
  v_ajustes jsonb := '[]'::jsonb;
  v_bloquea boolean := false;
begin
  select * into v_i from public.order_incidents where id = p_incident_id;
  if v_i.id is null then
    return jsonb_build_object('ajustes', '[]'::jsonb, 'bloquea', false);
  end if;
  select * into v_o from public.orders where id = v_i.order_id;

  -- El repartidor de la flota del PROPIO local —o un pedido que llevó el
  -- local— lo paga el local: es suyo.
  if p_responsible = 'local' then
    v_cobra := 'local';
  elsif p_responsible = 'repartidor' then
    select * into v_c from public.couriers where id = coalesce(v_i.courier_id, v_o.courier_id);
    if v_c.id is null or v_c.fleet_business_id is not null then
      v_cobra := 'local';
    else
      v_cobra := 'motorizado';
      v_courier := v_c.id;
    end if;
  end if;

  if v_i.kind in ('falta_producto', 'vino_mal', 'no_llego') then
    v_l := coalesce(v_i.local_cents, 0);
    v_u := coalesce(v_i.umbani_cents, 0);
    v_r := coalesce(v_i.reparto_cents, 0);
    v_efectivo := coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar');
    -- Umbani devuelve SU parte de lo que se devolvió: si el superadmin compensa
    -- menos de lo sugerido, su comisión baja en la misma proporción.
    v_comision := case when v_l + v_u + v_r > 0
                       then round(v_s::numeric * v_u / (v_l + v_u + v_r))::integer else 0 end;

    if v_i.kind = 'no_llego' then
      -- ⚠️ En EFECTIVO el libro anotó que quien entregó COBRÓ: no lo cobró.
      -- Se deshace (salvo si responde el cliente: entonces sí llegó).
      if v_efectivo and p_responsible in ('local', 'repartidor', 'umbani') then
        select * into v_libro from public.order_ledger
         where order_id = v_o.id and kind = 'venta';
        if v_libro.id is not null and v_libro.en_mano in ('local', 'motorizado') and v_libro.en_mano_cents > 0
           and not exists (select 1 from public.order_ledger r where r.order_id = v_o.id and r.kind = 'reverso') then
          v_ajustes := v_ajustes || jsonb_build_object(
            'party', v_libro.en_mano,
            'courierId', case when v_libro.en_mano = 'motorizado' then v_libro.courier_id end,
            'cents', v_libro.en_mano_cents,
            'concepto', 'no_cobro');
        end if;
      end if;
      -- Paga la comida y la carrera; si pagó por adelantado, lo devuelto
      -- menos la comisión de Umbani (nunca más que eso).
      v_x := case when v_efectivo then v_l + v_r else least(v_s - v_comision, v_l + v_r) end;
    else
      -- Faltó o vino mal: lo devuelto menos la comisión, hasta lo del local.
      v_x := greatest(0, least(v_s - v_comision, v_l));
    end if;

    if v_cobra is not null and v_x > 0 then
      v_ajustes := v_ajustes || jsonb_build_object(
        'party', v_cobra, 'courierId', v_courier, 'cents', -v_x, 'concepto', 'reclamo');
    end if;
  else
    -- Lo operativo, antes de entregar: la comida que se perdió (la decide el
    -- superadmin; por defecto, lo que el local recibe por los productos). Si
    -- responde el propio local, la pierde él y no hay nada que ajustar.
    if v_s > 0 and v_cobra is distinct from 'local' then
      v_ajustes := v_ajustes || jsonb_build_object(
        'party', 'local', 'courierId', null, 'cents', v_s, 'concepto', 'comida_reconocida');
      if v_cobra = 'motorizado' then
        v_ajustes := v_ajustes || jsonb_build_object(
          'party', 'motorizado', 'courierId', v_courier, 'cents', -v_s, 'concepto', 'comida_cobrada');
      end if;
    end if;
    -- Decisión del dueño: el cliente que no estaba queda bloqueado.
    v_bloquea := v_i.kind = 'cliente_ausente' and p_responsible = 'cliente';
  end if;

  return jsonb_build_object('ajustes', v_ajustes, 'bloquea', v_bloquea);
end;
$$;

revoke all on function public.efecto_de_la_incidencia(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.efecto_de_la_incidencia(uuid, text, integer) to service_role;


-- ── 4. Aplicarlo: al resolver, una vez ──────────────────────────────────────
-- Solo la llama `resolve_incident`, en su misma transacción.
create or replace function public.aplicar_ajustes_de_la_incidencia(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.order_incidents%rowtype;
  v_o public.orders%rowtype;
  v_efecto jsonb;
  v_a jsonb;
begin
  select * into v_i from public.order_incidents where id = p_incident_id;
  if v_i.id is null or v_i.status <> 'resuelta' then
    return '[]'::jsonb;
  end if;
  select * into v_o from public.orders where id = v_i.order_id;
  v_efecto := public.efecto_de_la_incidencia(v_i.id, v_i.responsible, v_i.compensation_cents);

  for v_a in select value from jsonb_array_elements(v_efecto -> 'ajustes')
  loop
    insert into public.settlement_adjustments (
      incident_id, order_id, business_id, party, courier_id, cents, concepto
    ) values (
      v_i.id, v_i.order_id, v_i.business_id, v_a ->> 'party',
      nullif(v_a ->> 'courierId', '')::uuid, (v_a ->> 'cents')::integer, v_a ->> 'concepto'
    )
    on conflict (incident_id, party, concepto) do nothing;
    perform public.anotar_movimiento_de_dinero(
      v_i.business_id, 'ajuste_por_incidencia', 'settlement_adjustments', v_i.id::text,
      jsonb_build_object('numero', v_o.order_number, 'parte', v_a ->> 'party',
                         'cents', (v_a ->> 'cents')::integer, 'concepto', v_a ->> 'concepto',
                         'tipo', v_i.kind));
  end loop;

  if coalesce((v_efecto ->> 'bloquea')::boolean, false) and v_o.customer_id is not null then
    update public.customers
       set blocked_at = now(), blocked_until = null, blocked_kind = 'manual',
           blocked_reason = left(format('No estaba para recibir su pedido #%s', v_o.order_number), 200)
     where id = v_o.customer_id and blocked_at is null;
  end if;

  return v_efecto -> 'ajustes';
end;
$$;

revoke all on function public.aplicar_ajustes_de_la_incidencia(uuid) from public, anon, authenticated;


-- ── 5. Resolver: al confirmar quién responde, nacen sus ajustes ─────────────
-- Copiada ENTERA de la vigente (migration-2026-10-10-saldo-umbani.sql);
-- cambia solo lo marcado (2026-10-12).

create or replace function public.resolve_incident(
  p_id uuid, p_status text, p_responsible text, p_compensation_cents integer, p_note text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.order_incidents%rowtype;
  v_o public.orders%rowtype;
  v_total integer;
  v_cliente uuid;
  v_saldo integer := 0;
  v_actor text := left(coalesce(p_actor, 'superadmin'), 120);
  -- Los ajustes de la liquidación que nacen al confirmar quién responde (2026-10-12).
  v_ajustes jsonb := '[]'::jsonb;
begin
  select * into v_i from public.order_incidents where id = p_id for update;
  if v_i.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_i.status not in ('abierta', 'compensada') then return jsonb_build_object('result', 'ya_resuelta'); end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_invalida');
  end if;

  if p_status = 'descartada' then
    update public.order_incidents
       set status = 'descartada', resolution_note = btrim(p_note), resolved_by = v_actor, resolved_at = now()
     where id = p_id;
    return jsonb_build_object('result', 'ok');
  end if;
  if p_status is distinct from 'resuelta'
     or p_responsible is null or p_responsible not in ('local', 'repartidor', 'cliente', 'umbani') then
    return jsonb_build_object('result', 'datos_invalidos');
  end if;

  if v_i.status = 'compensada' then
    -- El saldo ya se dio: el monto no se reescribe (un negativo = «el mismo»).
    if p_compensation_cents is not null and p_compensation_cents >= 0
       and p_compensation_cents <> v_i.compensation_cents then
      return jsonb_build_object('result', 'compensacion_ya_dada', 'compensacionCents', v_i.compensation_cents);
    end if;
    update public.order_incidents
       set status = 'resuelta', responsible = p_responsible,
           resolution_note = btrim(p_note), resolved_by = v_actor, resolved_at = now()
     where id = p_id;
    -- Primero el cliente (ya tiene su saldo); ahora, que pague quien responde.
    v_ajustes := public.aplicar_ajustes_de_la_incidencia(p_id);
    return jsonb_build_object('result', 'ok', 'saldoCents', 0, 'ajustes', v_ajustes);
  end if;

  select * into v_o from public.orders o where o.id = v_i.order_id;
  v_total := round(coalesce(v_o.total, 0) * 100)::integer;
  if p_compensation_cents is null or p_compensation_cents < 0 or p_compensation_cents > v_total then
    return jsonb_build_object('result', 'compensacion_invalida', 'maximoCents', v_total);
  end if;
  -- Si responde el cliente de lo que dijo no haber recibido, no hay nada que devolverle.
  if p_responsible = 'cliente' and p_compensation_cents > 0
     and v_i.kind in ('falta_producto', 'vino_mal', 'no_llego') then
    return jsonb_build_object('result', 'cliente_sin_compensacion');
  end if;

  if p_compensation_cents > 0 and p_responsible <> 'cliente'
     and v_i.kind in ('falta_producto', 'vino_mal', 'no_llego') then
    v_cliente := coalesce(v_i.customer_id, public.cliente_del_telefono(v_o.contact_phone));
    if v_cliente is null then return jsonb_build_object('result', 'sin_cuenta'); end if;
    perform public.abonar_saldo(v_i.id, v_cliente, p_compensation_cents);
    v_saldo := p_compensation_cents;
  end if;

  update public.order_incidents
     set status = 'resuelta', responsible = p_responsible, compensation_cents = p_compensation_cents,
         resolution_note = btrim(p_note), resolved_by = v_actor, resolved_at = now(),
         customer_id = coalesce(customer_id, v_cliente),
         compensated_at = case when v_saldo > 0 then now() else compensated_at end
   where id = p_id;
  -- Que pague quien responde (2026-10-12): el lunes, en su liquidación.
  v_ajustes := public.aplicar_ajustes_de_la_incidencia(p_id);
  return jsonb_build_object('result', 'ok', 'saldoCents', v_saldo, 'ajustes', v_ajustes);
end;
$$;


-- ── 6. El cierre del lunes y los saldos en curso suman los ajustes ──────────
-- Copiadas ENTERAS de las vigentes (migration-2026-10-10-usar-el-saldo.sql).

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
    arrastre integer, cuota integer, billing_id uuid, ajustes integer
  ) on commit drop;
  truncate pg_temp.tmp_cierre;

  insert into pg_temp.tmp_cierre (business_id, pedidos, derecho, en_mano, arrastre, cuota, billing_id, ajustes)
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           -- Lo que el local tiene en la mano: sin lo pagado con saldo, que lo pone Umbani.
           coalesce(sum(case when l.en_mano = 'local' then l.en_mano_cents else 0 end), 0)::integer as en_mano
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
  -- Los ajustes por incidencias (2026-10-12): lo que se le reconoce (+) o se le
  -- cobra (−) al local por lo que pasó con un pedido.
  ajustes as (
    select a.business_id, sum(a.cents)::integer as ajustes
    from public.settlement_adjustments a
    where a.party = 'local' and a.settlement_id is null and a.created_at < v_hasta
    group by a.business_id
  ),
  base as (
    select coalesce(l.business_id, d.business_id, a.business_id) as business_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre,
           coalesce(a.ajustes, 0) as ajustes
    from libro l
    full join deuda d on d.business_id = l.business_id
    full join ajustes a on a.business_id = coalesce(l.business_id, d.business_id)
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
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre + x.ajustes >= f.cents
              then f.cents else 0 end,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre + x.ajustes >= f.cents
              then f.billing_id end,
         x.ajustes
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
    ajustes_cents, neto_cents, status
  )
  select t.business_id, 'local', p_week_start, p_week_start + 6, t.pedidos,
         t.derecho, t.en_mano, t.arrastre, t.cuota, t.billing_id,
         t.ajustes,
         t.derecho - t.en_mano + t.arrastre - t.cuota + t.ajustes,
         case
           when t.derecho - t.en_mano + t.arrastre - t.cuota + t.ajustes > 0 then 'por_pagar'
           when t.derecho - t.en_mano + t.arrastre - t.cuota + t.ajustes < 0 then 'por_cobrar'
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

  -- Cada ajuste se liquida UNA vez (2026-10-12).
  update public.settlement_adjustments a
     set settlement_id = s.id
    from public.settlements s
   where s.business_id = a.business_id and s.party = 'local' and s.courier_id is null
     and s.period_start = p_week_start
     and a.party = 'local' and a.settlement_id is null and a.created_at < v_hasta
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = a.business_id);

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

-- Devuelve una columna más: se borra la versión anterior para recrearla.
drop function if exists public.settlement_balances(uuid);

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
  payphone_cents   integer,
  -- Lo que se le reconoce (+) o se le cobra (−) por incidencias (2026-10-12).
  ajustes_cents    integer
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
           -- Sin lo pagado con saldo Umbani: eso lo pone Umbani (2026-10-10).
           coalesce(sum(case when l.en_mano = 'local' then l.en_mano_cents else 0 end), 0)::integer as en_mano,
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
  ),
  ajustes as (
    select a.business_id, sum(a.cents)::integer as ajustes
    from public.settlement_adjustments a
    where a.party = 'local' and a.settlement_id is null
      and (p_business_id is null or a.business_id = p_business_id)
    group by a.business_id
  )
  select coalesce(l.business_id, d.business_id, a.business_id), b.name,
         coalesce(l.pedidos, 0), coalesce(l.pedidos_tarjeta, 0),
         coalesce(l.derecho, 0), coalesce(l.en_mano, 0), coalesce(d.arrastre, 0),
         coalesce(l.derecho, 0) - coalesce(l.en_mano, 0) + coalesce(d.arrastre, 0) + coalesce(a.ajustes, 0),
         coalesce(l.umbani, 0), coalesce(l.payphone, 0), coalesce(a.ajustes, 0)
  from libro l
  full join deuda d on d.business_id = l.business_id
  full join ajustes a on a.business_id = coalesce(l.business_id, d.business_id)
  join public.businesses b on b.id = coalesce(l.business_id, d.business_id, a.business_id)
  order by 8 desc;
$$;

revoke all on function public.settlement_balances(uuid) from public, anon, authenticated;
grant execute on function public.settlement_balances(uuid) to service_role;

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
           -- El efectivo que cobró: sin lo pagado con saldo Umbani (2026-10-10).
           coalesce(sum(case when l.en_mano = 'motorizado' then l.en_mano_cents else 0 end), 0)::integer as en_mano
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
  -- Los ajustes por incidencias (2026-10-12): lo que se le cobra (−) o se le
  -- devuelve (+) por lo que pasó con un pedido.
  ajustes as (
    select a.courier_id, sum(a.cents)::integer as ajustes
    from public.settlement_adjustments a
    where a.party = 'motorizado' and a.courier_settlement_id is null and a.created_at < v_hasta
    group by a.courier_id
  ),
  base as (
    select coalesce(l.courier_id, d.courier_id, a.courier_id) as courier_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre,
           coalesce(a.ajustes, 0) as ajustes
    from libro l full join deuda d on d.courier_id = l.courier_id
    full join ajustes a on a.courier_id = coalesce(l.courier_id, d.courier_id)
  )
  insert into public.courier_settlements (
    courier_id, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, ajustes_cents, neto_cents, status
  )
  select b.courier_id, p_week_start, p_week_start + 6, b.pedidos,
         b.derecho, b.en_mano, b.arrastre, b.ajustes, b.derecho - b.en_mano + b.arrastre + b.ajustes,
         case when b.derecho - b.en_mano + b.arrastre + b.ajustes > 0 then 'por_pagar'
              when b.derecho - b.en_mano + b.arrastre + b.ajustes < 0 then 'por_cobrar'
              else 'en_cero' end
  from base b
  on conflict (courier_id, period_start) do nothing;
  get diagnostics v_creadas = row_count;

  update public.order_ledger l
     set courier_settlement_id = s.id
    from public.courier_settlements s
   where s.courier_id = l.courier_id and s.period_start = p_week_start
     and l.courier_settlement_id is null and l.sold_at < v_hasta;

  -- Cada ajuste se liquida UNA vez (2026-10-12).
  update public.settlement_adjustments a
     set courier_settlement_id = s.id
    from public.courier_settlements s
   where s.courier_id = a.courier_id and s.period_start = p_week_start
     and a.party = 'motorizado' and a.courier_settlement_id is null and a.created_at < v_hasta;

  update public.courier_settlements s
     set status = 'compensada', updated_at = now()
   where s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from public.courier_settlements n
                 where n.courier_id = s.courier_id and n.period_start = p_week_start);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

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
    'efectivoCobradoCents', coalesce(sum(case when l.en_mano = 'motorizado' then l.en_mano_cents else 0 end), 0),
    'deAntesCents', coalesce((select sum(neto_cents) from public.courier_settlements
                              where courier_id = p_courier_id and status = 'por_cobrar'), 0),
    'efectivoEncimaCents', public.courier_cash_in_hand(p_courier_id),
    -- Lo que se le cobra (−) o devuelve (+) por incidencias, aún sin liquidar (2026-10-12).
    'ajustesCents', coalesce((select sum(a.cents) from public.settlement_adjustments a
                              where a.courier_id = p_courier_id and a.party = 'motorizado'
                                and a.courier_settlement_id is null), 0)
  )
  from public.order_ledger l
  where l.courier_id = p_courier_id and l.courier_settlement_id is null
$$;


-- ── 7. El efectivo encima no cuenta lo que no cobró ─────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-10-usar-el-saldo.sql);
-- cambia solo lo marcado (2026-10-12). Un «no llegó» en efectivo deshace un
-- cobro que el libro anotó y no ocurrió (`no_cobro`): ese dinero no lo tiene,
-- y no puede contarle para el tope de efectivo hasta el lunes.
create or replace function public.courier_cash_in_hand(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((
      select sum(en_mano_cents) from public.order_ledger
      where courier_id = p_courier_id and en_mano = 'motorizado' and courier_settlement_id is null
    ), 0)
    + coalesce((
      -- Lo que va a cobrar: sin lo pagado con saldo Umbani (2026-10-10).
      select sum(round(o.total * 100) - coalesce(o.credit_cents, 0)) from public.orders o
      where o.courier_id = p_courier_id
        and coalesce(o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
        and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado')
    ), 0)
    -- Lo que el libro dice que cobró y no cobró (2026-10-12).
    - coalesce((
      select sum(a.cents) from public.settlement_adjustments a
      where a.courier_id = p_courier_id and a.party = 'motorizado'
        and a.concepto = 'no_cobro' and a.courier_settlement_id is null
    ), 0)
  )::integer
$$;
