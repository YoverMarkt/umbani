-- ============================================================================
-- LAS INCIDENCIAS Y EL «¿LLEGÓ TODO BIEN?» DEL CLIENTE — fase 1, sin mover dinero
--
-- Decisión del dueño (2026-10-06): «en la app del cliente tenemos que crear
-- algo para que el cliente diga todo está correcto con su pedido… en las
-- grandes, cuando no me llega algo me dan dinero de la app». Como las grandes:
--
--   · Al recibir, el cliente dice «Todo bien» o reporta qué faltó, qué vino
--     mal o que no llegó. Una vez por pedido y en las 48 horas siguientes a la
--     entrega (Uber Eats da 48 h; pasado el plazo, lo asume la plataforma).
--   · La BASE calcula cuánto le corresponde: lo que pagó por esas unidades
--     —el precio del local más su parte del margen de Umbani—, nunca más que
--     el total del pedido. Si no llegó nada, el pedido entero.
--   · El superadmin lo revisa y decide quién responde (el local, el
--     repartidor, el cliente o Umbani) con la tabla de incidencias aprobada.
--     También registra las que no vienen del cliente: comida caída, cliente
--     ausente, accidente, repartidor que no apareció.
--
-- ⚠️ ESTA FASE NO MUEVE DINERO. La compensación queda decidida y anotada; el
-- saldo Umbani del cliente y el descuento en la liquidación del responsable
-- llegan en la fase 2, con su propia migración, porque tocan el cálculo del
-- dinero y el dueño decide antes sus números (plazo, tope, vencimiento).
-- ============================================================================


-- ── 1. «Todo bien» ─────────────────────────────────────────────────────────
alter table public.orders
  add column if not exists received_ok_at timestamptz;
comment on column public.orders.received_ok_at is
  'Cuándo el cliente dijo «Todo bien» con su pedido entregado.';


-- ── 2. Las incidencias de un pedido ────────────────────────────────────────
create table if not exists public.order_incidents (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  order_id           uuid not null,
  -- Quién lo llevaba cuando pasó (si lo llevó alguien de una flota).
  courier_id         uuid references public.couriers(id) on delete set null,
  kind               text not null,
  -- Quién la abrió: el cliente desde la app, o el superadmin.
  origin             text not null,
  status             text not null default 'abierta',
  -- Se decide al resolver.
  responsible        text,
  -- Las unidades reportadas: [{ item, nombre, cantidad, centavos }].
  lines              jsonb not null default '[]'::jsonb,
  note               text,
  -- Lo que calculó la base al abrirla (lo que pagó el cliente por eso).
  suggested_cents    integer not null default 0,
  -- Lo que se decidió compensar al resolver.
  compensation_cents integer,
  resolution_note    text,
  resolved_by        text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,

  constraint order_incidents_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint order_incidents_kind_check check (kind in (
    'falta_producto', 'vino_mal', 'no_llego',
    'comida_caida', 'cliente_ausente', 'accidente', 'no_aparecio', 'otro'
  )),
  constraint order_incidents_origin_check check (origin in ('cliente', 'superadmin')),
  constraint order_incidents_status_check check (status in ('abierta', 'resuelta', 'descartada')),
  constraint order_incidents_responsible_check check (
    responsible is null or responsible in ('local', 'repartidor', 'cliente', 'umbani')
  ),
  constraint order_incidents_texto_check check (
    (note is null or char_length(note) <= 500)
    and (resolution_note is null or char_length(resolution_note) <= 500)
  ),
  constraint order_incidents_centavos_check check (
    suggested_cents >= 0 and (compensation_cents is null or compensation_cents >= 0)
  ),
  -- Resuelta = se sabe quién responde, cuánto se compensa y cuándo.
  constraint order_incidents_resuelta_check check (
    status = 'abierta'
    or (status = 'descartada' and resolved_at is not null)
    or (status = 'resuelta' and resolved_at is not null and responsible is not null and compensation_cents is not null)
  ),
  constraint order_incidents_lines_check check (jsonb_typeof(lines) = 'array')
);

-- El cliente reclama UNA vez por pedido.
create unique index if not exists order_incidents_un_reclamo_por_pedido
  on public.order_incidents (order_id) where origin = 'cliente';
create index if not exists idx_order_incidents_estado on public.order_incidents (status, created_at desc);
create index if not exists idx_order_incidents_negocio on public.order_incidents (business_id, created_at desc);
create index if not exists idx_order_incidents_repartidor on public.order_incidents (courier_id) where courier_id is not null;

alter table public.order_incidents enable row level security;
revoke all on table public.order_incidents from anon, authenticated;
comment on table public.order_incidents is
  'Incidencias de un pedido: las reporta el cliente (falta, vino mal, no llegó) o las registra el superadmin. Fase 1: no mueven dinero.';


-- ── 3. El pedido de ESTE teléfono, entregado ───────────────────────────────
-- La pregunta común a «Todo bien» y al reclamo. El teléfono, con y sin «+»
-- (YCloud lo manda con él; los pedidos se guardan sin él).
create or replace function public.pedido_entregado_de(p_order_id uuid, p_phone text)
returns table (order_id uuid, business_id uuid, status text, entregado_en timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.business_id, o.status,
         coalesce(
           (select max(s.sold_at) from public.sales s where s.order_id = o.id),
           (select max(e.created_at) from public.order_events e where e.order_id = o.id and e.to_status = 'completado'),
           o.updated_at)
  from public.orders o
  where o.id = p_order_id
    and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    and o.contact_phone in (regexp_replace(p_phone, '\D', '', 'g'), '+' || regexp_replace(p_phone, '\D', '', 'g'))
$$;

revoke all on function public.pedido_entregado_de(uuid, text) from public, anon, authenticated;


-- ── 4. «Todo bien» ─────────────────────────────────────────────────────────
create or replace function public.customer_confirm_order(p_order_id uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select * into v from public.pedido_entregado_de(p_order_id, p_phone);
  if v.order_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v.status <> 'completado' then return jsonb_build_object('result', 'no_entregado'); end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  update public.orders set received_ok_at = coalesce(received_ok_at, now()) where id = v.order_id;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.customer_confirm_order(uuid, text) from public, anon, authenticated;
grant execute on function public.customer_confirm_order(uuid, text) to service_role;


-- ── 5. El reclamo del cliente ──────────────────────────────────────────────
-- ⚠️ Lo que le corresponde lo calcula AQUÍ la base, nunca el teléfono: el
-- precio de cada unidad que pagó —el del local más su parte del margen de
-- Umbani—, en centavos. El porcentaje del margen no se guarda en el pedido
-- (sí su total), así que se reparte en PROPORCIÓN al precio de cada línea; la
-- tarifa de servicio no es de ningún producto y no entra. Nunca más que el
-- total del pedido.
create or replace function public.customer_report_order(
  p_order_id uuid, p_phone text, p_kind text, p_lines jsonb, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_o public.orders%rowtype;
  v_base numeric;
  v_factor numeric;
  v_fila record;
  v_lineas jsonb := '[]'::jsonb;
  v_sugerido bigint := 0;
  v_unidad integer;
  v_total integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_larga');
  end if;

  select * into v from public.pedido_entregado_de(p_order_id, p_phone);
  if v.order_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v.status <> 'completado' then return jsonb_build_object('result', 'no_entregado'); end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  if v.entregado_en < now() - interval '48 hours' then
    return jsonb_build_object('result', 'fuera_de_plazo');
  end if;

  select * into v_o from public.orders where id = v.order_id;
  v_total := round(coalesce(v_o.total, 0) * 100)::integer;

  if p_kind = 'no_llego' then
    -- No llegó nada: el pedido entero.
    v_sugerido := v_total;
  else
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      return jsonb_build_object('result', 'sin_lineas');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_lines) x
       where jsonb_typeof(x) <> 'object'
          or coalesce(x ->> 'item', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or coalesce(x ->> 'cantidad', '') !~ '^[0-9]{1,3}$'
    ) then
      return jsonb_build_object('result', 'linea_invalida');
    end if;

    select coalesce(sum(oi.line_total), 0) into v_base from public.order_items oi where oi.order_id = v_o.id;
    v_factor := case when v_base > 0
      then 1 + greatest(coalesce(v_o.platform_markup, 0) - coalesce(v_o.service_fee, 0), 0) / v_base
      else 1 end;

    -- La misma línea dos veces cuenta como una, sumando la cantidad.
    for v_fila in
      select (x ->> 'item')::uuid as item, sum((x ->> 'cantidad')::integer) as cantidad
        from jsonb_array_elements(p_lines) x
       group by 1
    loop
      declare
        v_item public.order_items%rowtype;
      begin
        select * into v_item from public.order_items oi where oi.id = v_fila.item and oi.order_id = v_o.id;
        if v_item.id is null or v_fila.cantidad < 1 or v_fila.cantidad > v_item.quantity then
          return jsonb_build_object('result', 'linea_invalida');
        end if;
        v_unidad := round(round(v_item.line_total / v_item.quantity, 2) * v_factor * 100)::integer;
        v_sugerido := v_sugerido + v_unidad::bigint * v_fila.cantidad;
        v_lineas := v_lineas || jsonb_build_object(
          'item', v_item.id, 'nombre', v_item.product_name, 'cantidad', v_fila.cantidad,
          'centavos', v_unidad * v_fila.cantidad);
      end;
    end loop;
    v_sugerido := least(v_sugerido, v_total);
  end if;

  insert into public.order_incidents (business_id, order_id, courier_id, kind, origin, lines, note, suggested_cents)
  values (v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'cliente', v_lineas,
          nullif(btrim(coalesce(p_note, '')), ''), v_sugerido::integer)
  returning id into v_id;

  return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer);
exception
  -- Dos toques a la vez: el índice único deja entrar uno solo.
  when unique_violation then
    return jsonb_build_object('result', 'ya_reclamado');
end;
$$;

revoke all on function public.customer_report_order(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.customer_report_order(uuid, text, text, jsonb, text) to service_role;


-- ── 6. Las que registra el superadmin ──────────────────────────────────────
-- Las que el cliente no ve: comida caída, cliente ausente, accidente, el
-- repartidor que no apareció. El pedido se nombra por su local y su número.
create or replace function public.register_incident(
  p_business_id uuid, p_order_number integer, p_kind text, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego', 'comida_caida',
                                      'cliente_ausente', 'accidente', 'no_aparecio', 'otro') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_invalida');
  end if;
  select * into v_o from public.orders where business_id = p_business_id and order_number = p_order_number;
  if v_o.id is null then return jsonb_build_object('result', 'not_found'); end if;

  insert into public.order_incidents (business_id, order_id, courier_id, kind, origin, note)
  values (v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'superadmin', btrim(p_note))
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'id', v_id);
end;
$$;

revoke all on function public.register_incident(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.register_incident(uuid, integer, text, text) to service_role;


-- ── 7. Resolverla ──────────────────────────────────────────────────────────
-- Quién responde y cuánto se compensa al cliente; o descartarla (con motivo).
-- ⚠️ Una resuelta no se reescribe: en la fase 2 de ella colgará dinero.
-- La compensación nunca pasa del total del pedido.
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
  v_total integer;
begin
  select * into v_i from public.order_incidents where id = p_id for update;
  if v_i.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_i.status <> 'abierta' then return jsonb_build_object('result', 'ya_resuelta'); end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_invalida');
  end if;

  if p_status = 'descartada' then
    update public.order_incidents
       set status = 'descartada', resolution_note = btrim(p_note), resolved_by = left(coalesce(p_actor, 'superadmin'), 120), resolved_at = now()
     where id = p_id;
    return jsonb_build_object('result', 'ok');
  end if;
  if p_status is distinct from 'resuelta'
     or p_responsible is null or p_responsible not in ('local', 'repartidor', 'cliente', 'umbani') then
    return jsonb_build_object('result', 'datos_invalidos');
  end if;
  select round(coalesce(o.total, 0) * 100)::integer into v_total from public.orders o where o.id = v_i.order_id;
  if p_compensation_cents is null or p_compensation_cents < 0 or p_compensation_cents > v_total then
    return jsonb_build_object('result', 'compensacion_invalida', 'maximoCents', v_total);
  end if;

  update public.order_incidents
     set status = 'resuelta', responsible = p_responsible, compensation_cents = p_compensation_cents,
         resolution_note = btrim(p_note), resolved_by = left(coalesce(p_actor, 'superadmin'), 120), resolved_at = now()
   where id = p_id;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.resolve_incident(uuid, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.resolve_incident(uuid, text, text, integer, text, text) to service_role;
