-- ============================================================================
-- EL SALDO UMBANI — fase 2 de las incidencias, parte 1 (2026-10-10)
--
-- Reglas del dueño (2026-10-10, decididas con el simulador):
--
--   · TODO EMPIEZA CUANDO EL CLIENTE REPORTA. Si no dice nada, todo llegó
--     bien: nadie le pide confirmar.
--   · Lo que no recibió bien (faltó, vino mal, no llegó) se le devuelve como
--     SALDO UMBANI: no se cambia por efectivo, sirve en cualquier local y
--     vence a los 90 días. Así Umbani no guarda dinero de nadie.
--   · AL INSTANTE, lo pequeño: faltó o vino mal, hasta $5, uno cada 30 días,
--     con foto si vino mal y con el historial limpio. «No llegó» siempre lo
--     revisa una persona: es el reclamo con el que más se engaña.
--   · Si iba a pagar en efectivo y el pedido no llegó, NO pagó: no hay nada
--     que devolverle en saldo.
--   · PRIMERO EL CLIENTE: el saldo puede ser instantáneo, pero al responsable
--     se le cobra (parte 3) solo cuando el superadmin confirma quién responde.
--   · LA ESCALERA. Escalón 2, a revisión: 2 o más reportes en 90 días, más de
--     1 de cada 5 pedidos (desde el 2.º reporte: un reclamo solo no es un
--     patrón) o un rechazo en 90 días. Escalón 3: 2 rechazos, y ya no recibe
--     saldo al instante (y en la parte 2, solo paga por adelantado). Bloquear
--     lo decide una persona. Las cuentas que compraron desde el mismo
--     dispositivo comparten historial.
--   · Los números se cambian en `server_settings`, sin tocar código.
--
-- Esta parte DA el saldo. Usarlo al pedir es la parte 2; cobrárselo al
-- responsable en la liquidación del lunes, la parte 3.
-- ============================================================================


-- ── 0. Los números, editables sin tocar código ─────────────────────────────
-- Un número de `server_settings`, o el de siempre si falta o no es un número.
-- Se acota: un valor absurdo escrito a mano no puede regalar saldo.
create or replace function public.parametro_entero(
  p_clave text, p_defecto integer, p_minimo integer, p_maximo integer
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select least(greatest(btrim(value)::integer, p_minimo), p_maximo)
      from public.server_settings
     where key = p_clave and btrim(value) ~ '^[0-9]{1,6}$'
  ), p_defecto)
$$;

revoke all on function public.parametro_entero(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.parametro_entero(text, integer, integer, integer) to service_role;


-- ── 1. La incidencia, con lo que hace falta para el dinero ─────────────────
alter table public.order_incidents
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists auto_approved boolean not null default false,
  add column if not exists compensated_at timestamptz,
  add column if not exists local_cents integer,
  add column if not exists umbani_cents integer,
  add column if not exists reparto_cents integer,
  add column if not exists photo_public_id text,
  add column if not exists escalon smallint,
  add column if not exists review_reasons text[] not null default '{}';

comment on column public.order_incidents.customer_id is
  'La cuenta del cliente que reportó: a ella va el saldo.';
comment on column public.order_incidents.auto_approved is
  'El saldo se dio AL INSTANTE, por la regla, sin que lo revisara una persona.';
comment on column public.order_incidents.compensated_at is
  'Cuándo recibió el cliente su saldo.';
comment on column public.order_incidents.local_cents is
  'De lo reportado, lo que era del local (para cobrárselo al responsable en la parte 3).';
comment on column public.order_incidents.umbani_cents is
  'De lo reportado, la comisión de Umbani: la devuelve Umbani.';
comment on column public.order_incidents.reparto_cents is
  'De lo reportado, la carrera (solo cuando no llegó).';
comment on column public.order_incidents.photo_public_id is
  'La foto que mandó el cliente (privada en Cloudinary, en la carpeta reclamos/<pedido>).';
comment on column public.order_incidents.escalon is
  'El escalón de la escalera del cliente al reportar (1 normal, 2 en revisión, 3 sin saldo al instante).';
comment on column public.order_incidents.review_reasons is
  'Por qué NO se aprobó al instante. Lo ve el superadmin; al cliente no se le dice la regla.';

-- «compensada» = el cliente ya tiene su saldo y falta confirmar quién responde.
alter table public.order_incidents drop constraint if exists order_incidents_status_check;
alter table public.order_incidents add constraint order_incidents_status_check
  check (status in ('abierta', 'compensada', 'resuelta', 'descartada'));
alter table public.order_incidents drop constraint if exists order_incidents_resuelta_check;
alter table public.order_incidents add constraint order_incidents_resuelta_check check (
  status = 'abierta'
  or (status = 'compensada' and compensation_cents is not null and compensated_at is not null)
  or (status = 'descartada' and resolved_at is not null)
  or (status = 'resuelta' and resolved_at is not null and responsible is not null and compensation_cents is not null)
);
alter table public.order_incidents drop constraint if exists order_incidents_dinero_check;
alter table public.order_incidents add constraint order_incidents_dinero_check check (
  (local_cents is null or local_cents >= 0)
  and (umbani_cents is null or umbani_cents >= 0)
  and (reparto_cents is null or reparto_cents >= 0)
  and (escalon is null or escalon between 1 and 3)
  and (photo_public_id is null or char_length(photo_public_id) <= 300)
);

create index if not exists idx_order_incidents_cliente
  on public.order_incidents (customer_id, created_at desc) where customer_id is not null;


-- ── 2. El saldo: lotes que vencen, y lo que se gasta de cada uno ───────────
-- ⚠️ Es de la PERSONA, no de un local: como `customers`, no lleva
-- `business_id`. Solo el servidor la toca (RLS sin políticas). Cada lote
-- dice de qué incidencia salió, y cada uso de qué pedido y de qué local.
-- ⚠️ Nada se borra ni se edita: el saldo es la suma de lo que queda en los
-- lotes que no han vencido. Si un pedido que lo usó se cancela, su uso se
-- marca devuelto (`reversed_at`) y el saldo vuelve a su lote.
create table if not exists public.customer_credit_lots (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  incident_id uuid not null references public.order_incidents(id) on delete restrict,
  cents       integer not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,

  constraint customer_credit_lots_datos_check check (cents > 0 and expires_at > created_at),
  -- Una incidencia da saldo UNA vez.
  constraint customer_credit_lots_una_por_incidencia unique (incident_id)
);

create index if not exists idx_customer_credit_lots_cliente
  on public.customer_credit_lots (customer_id, expires_at);

alter table public.customer_credit_lots enable row level security;
revoke all on table public.customer_credit_lots from anon, authenticated;
comment on table public.customer_credit_lots is
  'Saldo Umbani: cada lote nace de una incidencia resuelta a favor del cliente y vence. No se cambia por efectivo.';

create table if not exists public.customer_credit_uses (
  id          uuid primary key default gen_random_uuid(),
  lot_id      uuid not null references public.customer_credit_lots(id) on delete restrict,
  order_id    uuid not null,
  business_id uuid not null,
  cents       integer not null,
  created_at  timestamptz not null default now(),
  -- El pedido que lo usó se canceló: el saldo vuelve a su lote.
  reversed_at timestamptz,

  constraint customer_credit_uses_pedido_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete restrict,
  constraint customer_credit_uses_datos_check check (cents > 0),
  constraint customer_credit_uses_una_por_lote unique (order_id, lot_id)
);

create index if not exists idx_customer_credit_uses_lote on public.customer_credit_uses (lot_id);

alter table public.customer_credit_uses enable row level security;
revoke all on table public.customer_credit_uses from anon, authenticated;
comment on table public.customer_credit_uses is
  'Lo que un pedido gastó del saldo Umbani, lote por lote (parte 2). Devuelto = reversed_at.';


-- ── 3. La cuenta de un teléfono ────────────────────────────────────────────
-- La que lo reclamó en exclusiva (`customers.phone`), con y sin «+».
create or replace function public.cliente_del_telefono(p_phone text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id
    from public.customers c
   where regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
     and c.phone in (regexp_replace(p_phone, '\D', '', 'g'), '+' || regexp_replace(p_phone, '\D', '', 'g'))
   order by c.created_at
   limit 1
$$;

revoke all on function public.cliente_del_telefono(text) from public, anon, authenticated;


-- ── 4. El saldo de una persona ─────────────────────────────────────────────
-- Lo que queda en sus lotes vigentes, y el próximo que vence.
create or replace function public.saldo_del_cliente(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lotes as (
    select l.expires_at,
           greatest(l.cents - coalesce((
             select sum(u.cents) from public.customer_credit_uses u
              where u.lot_id = l.id and u.reversed_at is null
           ), 0), 0)::integer as restante
      from public.customer_credit_lots l
     where l.customer_id = p_customer_id and l.expires_at > now()
  )
  select jsonb_build_object(
    'cents', coalesce((select sum(restante) from lotes), 0)::integer,
    'proximo', (
      select jsonb_build_object('cents', restante, 'venceEl', expires_at)
        from lotes where restante > 0 order by expires_at limit 1
    )
  )
$$;

revoke all on function public.saldo_del_cliente(uuid) from public, anon, authenticated;
grant execute on function public.saldo_del_cliente(uuid) to service_role;


-- ── 5. La escalera de confianza ────────────────────────────────────────────
-- Con `p_nuevo`, cuenta el reporte que se está evaluando (aún no guardado).
-- ⚠️ Mira los RECHAZOS y la PROPORCIÓN, no solo cuántas veces reportó: un
-- cliente honesto puede tener mala suerte tres veces con un local que se
-- equivoca mucho. Y comparte historial con las cuentas que compraron desde
-- sus mismos dispositivos: abrir una cuenta nueva no limpia la escalera.
create or replace function public.escalera_del_cliente(p_customer_id uuid, p_nuevo boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_ventana integer := public.parametro_entero('escalera_ventana_dias', 90, 1, 3650);
  v_revision integer := public.parametro_entero('escalera_reportes_revision', 2, 1, 1000);
  v_cada integer := public.parametro_entero('escalera_proporcion_pedidos', 5, 1, 1000);
  v_sin_instante integer := public.parametro_entero('escalera_rechazos_sin_instante', 2, 1, 1000);
  v_cada_dias integer := public.parametro_entero('reclamo_al_instante_cada_dias', 30, 0, 3650);
  v_mas integer := case when p_nuevo then 1 else 0 end;
  v_telefonos text[];
  v_entregados integer := 0;
  v_reportes integer := 0;
  v_reportes_recientes integer := 0;
  v_rechazos integer := 0;
  v_rechazos_recientes integer := 0;
  v_al_instante integer := 0;
  v_escalon integer := 1;
  v_motivos text[] := '{}';
begin
  -- Sus teléfonos, con y sin «+»: el de su cuenta y los de quienes compraron
  -- desde sus mismos dispositivos.
  select coalesce(array_agg(distinct v), '{}') into v_telefonos
    from (
      select unnest(array[t, '+' || t]) as v
        from (
          select regexp_replace(c.phone, '\D', '', 'g') as t
            from public.customers c where c.id = p_customer_id and c.phone is not null
          union
          select regexp_replace(s2.contact_phone, '\D', '', 'g')
            from public.storefront_sessions s1
            join public.storefront_sessions s2 on s2.device_hash = s1.device_hash
           where s1.customer_id = p_customer_id and coalesce(s1.device_hash, '') <> ''
        ) digitos
       where coalesce(t, '') <> ''
    ) variantes;

  if cardinality(v_telefonos) > 0 then
    select count(*) into v_entregados
      from public.orders o
     where o.status = 'completado' and o.contact_phone = any (v_telefonos);

    -- Solo lo que el cliente no recibió bien: lo operativo no es un reclamo.
    -- Rechazo = descartada, o resuelta diciendo que respondía él.
    select count(*),
           count(*) filter (where i.created_at > now() - make_interval(days => v_ventana)),
           count(*) filter (where i.status = 'descartada' or i.responsible = 'cliente'),
           count(*) filter (where (i.status = 'descartada' or i.responsible = 'cliente')
                              and coalesce(i.resolved_at, i.created_at) > now() - make_interval(days => v_ventana)),
           count(*) filter (where i.auto_approved and i.compensated_at > now() - make_interval(days => v_cada_dias))
      into v_reportes, v_reportes_recientes, v_rechazos, v_rechazos_recientes, v_al_instante
      from public.order_incidents i
      join public.orders o on o.id = i.order_id
     where i.kind in ('falta_producto', 'vino_mal', 'no_llego')
       and o.contact_phone = any (v_telefonos);
  end if;

  if v_rechazos >= v_sin_instante then
    v_escalon := 3;
    v_motivos := array['rechazos'];
  else
    if v_reportes_recientes + v_mas >= v_revision then v_motivos := v_motivos || 'reportes_seguidos'::text; end if;
    if v_reportes + v_mas >= 2 and (v_reportes + v_mas) * v_cada > v_entregados then
      v_motivos := v_motivos || 'proporcion'::text;
    end if;
    if v_rechazos_recientes >= 1 then v_motivos := v_motivos || 'rechazo_reciente'::text; end if;
    if cardinality(v_motivos) > 0 then v_escalon := 2; end if;
  end if;

  return jsonb_build_object(
    'escalon', v_escalon, 'motivos', to_jsonb(v_motivos), 'entregados', v_entregados,
    'reportes', v_reportes, 'reportesRecientes', v_reportes_recientes,
    'rechazos', v_rechazos, 'rechazosRecientes', v_rechazos_recientes, 'alInstante', v_al_instante);
end;
$$;

revoke all on function public.escalera_del_cliente(uuid, boolean) from public, anon, authenticated;
grant execute on function public.escalera_del_cliente(uuid, boolean) to service_role;


-- ── 6. Abonar el saldo de una incidencia ───────────────────────────────────
-- Solo la llaman las funciones de abajo, dentro de su transacción.
create or replace function public.abonar_saldo(p_incident_id uuid, p_customer_id uuid, p_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vence timestamptz := now() + make_interval(days => public.parametro_entero('saldo_vence_dias', 90, 1, 3650));
begin
  if p_customer_id is null or p_cents is null or p_cents <= 0 then
    return jsonb_build_object('result', 'nada');
  end if;
  insert into public.customer_credit_lots (customer_id, incident_id, cents, expires_at)
  values (p_customer_id, p_incident_id, p_cents, v_vence);
  return jsonb_build_object('result', 'ok', 'cents', p_cents, 'venceEl', v_vence);
end;
$$;

revoke all on function public.abonar_saldo(uuid, uuid, integer) from public, anon, authenticated;


-- ── 7. El cliente reporta ──────────────────────────────────────────────────
-- Lo de la fase 1 (su pedido, entregado, 48 h, una vez; lo que le corresponde
-- lo calcula la base) más la fase 2: cuánto de eso era del local, de Umbani o
-- de la carrera; la foto; la escalera; y, si toca, el saldo AL INSTANTE.
-- ⚠️ La firma cambia (la foto): se borra la vieja para que no haya dos.
drop function if exists public.customer_report_order(uuid, text, text, jsonb, text);
create or replace function public.customer_report_order(
  p_order_id uuid, p_phone text, p_kind text, p_lines jsonb, p_note text, p_photo text default null
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
  v_local bigint := 0;
  v_umbani integer := 0;
  v_reparto integer := 0;
  v_unidad integer;
  v_unidad_local integer;
  v_total integer;
  v_id uuid;
  v_foto text := nullif(btrim(coalesce(p_photo, '')), '');
  v_cliente uuid;
  v_escalera jsonb;
  v_motivos text[] := '{}';
  v_tope integer := public.parametro_entero('reclamo_al_instante_tope_cents', 500, 0, 100000);
  v_foto_obligatoria boolean := public.parametro_entero('reclamo_foto_obligatoria', 1, 0, 1) = 1;
  v_lote jsonb;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_larga');
  end if;
  -- La foto la sube el servidor en la carpeta de ESTE pedido: otra no vale.
  if v_foto is not null
     and (char_length(v_foto) > 300 or position(('/reclamos/' || p_order_id::text || '/') in v_foto) = 0) then
    return jsonb_build_object('result', 'foto_invalida');
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
    -- No llegó nada: el pedido entero, repartido como lo reparte el libro.
    v_umbani := least(round(coalesce(v_o.platform_markup, 0) * 100)::integer, v_total);
    v_reparto := least(round(coalesce(v_o.shipping, 0) * 100)::integer, v_total - v_umbani);
    v_local := v_total - v_umbani - v_reparto;
    -- ⚠️ Iba a pagar al recibir y no recibió nada: NO pagó. No hay nada que
    -- devolverle en saldo (el reparto de arriba queda para cobrar la comida).
    v_sugerido := case when coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
                       then 0 else v_total end;
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
        v_unidad_local := round(round(v_item.line_total / v_item.quantity, 2) * 100)::integer;
        v_unidad := round(round(v_item.line_total / v_item.quantity, 2) * v_factor * 100)::integer;
        v_sugerido := v_sugerido + v_unidad::bigint * v_fila.cantidad;
        v_local := v_local + v_unidad_local::bigint * v_fila.cantidad;
        v_lineas := v_lineas || jsonb_build_object(
          'item', v_item.id, 'nombre', v_item.product_name, 'cantidad', v_fila.cantidad,
          'centavos', v_unidad * v_fila.cantidad);
      end;
    end loop;
    v_sugerido := least(v_sugerido, v_total);
    -- Del sugerido, lo del local; el resto es la comisión de Umbani.
    v_local := least(v_local, v_sugerido);
    v_umbani := (v_sugerido - v_local)::integer;
  end if;

  -- La escalera, con un candado por persona: dos reportes a la vez no pueden
  -- llevarse los dos el «uno cada 30 días».
  v_cliente := public.cliente_del_telefono(p_phone);
  if v_cliente is null then
    v_motivos := array['sin_cuenta'];
  else
    perform pg_advisory_xact_lock(hashtextextended('saldo:' || v_cliente::text, 0));
    v_escalera := public.escalera_del_cliente(v_cliente, true);
    select coalesce(array_agg(m), '{}') into v_motivos from jsonb_array_elements_text(v_escalera -> 'motivos') m;
  end if;
  if p_kind = 'no_llego' then v_motivos := v_motivos || 'no_llego'::text; end if;
  if v_sugerido = 0 then v_motivos := v_motivos || 'sin_monto'::text; end if;
  if v_sugerido > v_tope then v_motivos := v_motivos || 'tope'::text; end if;
  if coalesce((v_escalera ->> 'alInstante')::integer, 0) >= 1 then v_motivos := v_motivos || 'al_instante_reciente'::text; end if;
  if p_kind = 'vino_mal' and v_foto_obligatoria and v_foto is null then v_motivos := v_motivos || 'sin_foto'::text; end if;

  insert into public.order_incidents (
    business_id, order_id, courier_id, kind, origin, lines, note, suggested_cents,
    customer_id, local_cents, umbani_cents, reparto_cents, photo_public_id, escalon, review_reasons
  )
  values (
    v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'cliente', v_lineas,
    nullif(btrim(coalesce(p_note, '')), ''), v_sugerido::integer,
    v_cliente, v_local::integer, v_umbani, v_reparto, v_foto,
    (v_escalera ->> 'escalon')::smallint, v_motivos
  )
  returning id into v_id;

  if cardinality(v_motivos) = 0 then
    -- AL INSTANTE: el saldo ya. Quién responde lo confirma después el superadmin.
    v_lote := public.abonar_saldo(v_id, v_cliente, v_sugerido::integer);
    update public.order_incidents
       set status = 'compensada', compensation_cents = v_sugerido::integer,
           compensated_at = now(), auto_approved = true
     where id = v_id;
    return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer,
      'estado', 'compensada', 'saldoCents', v_sugerido::integer, 'venceEl', v_lote ->> 'venceEl');
  end if;

  return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer,
    'estado', 'abierta', 'saldoCents', 0);
exception
  -- Dos toques a la vez: el índice único deja entrar uno solo.
  when unique_violation then
    return jsonb_build_object('result', 'ya_reclamado');
end;
$$;

revoke all on function public.customer_report_order(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.customer_report_order(uuid, text, text, jsonb, text, text) to service_role;


-- ── 8. El superadmin resuelve ──────────────────────────────────────────────
-- Una ABIERTA: quién responde y cuánto; si es lo que el cliente no recibió
-- bien (faltó, vino mal, no llegó) y no responde él, el saldo se le da aquí.
-- Una COMPENSADA (saldo dado al instante): solo se confirma quién responde,
-- y el monto ya no cambia. Descartar una compensada no le quita el saldo: lo
-- absorbe Umbani, y cuenta como rechazo en su escalera.
-- ⚠️ Lo operativo (comida caída, accidente, cliente ausente…) no da saldo:
-- se resuelve cancelando el pedido con su responsable (parte 3).
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
    return jsonb_build_object('result', 'ok', 'saldoCents', 0);
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
  return jsonb_build_object('result', 'ok', 'saldoCents', v_saldo);
end;
$$;

revoke all on function public.resolve_incident(uuid, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.resolve_incident(uuid, text, text, integer, text, text) to service_role;
