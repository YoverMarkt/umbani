-- ============================================================================
-- «NO ESTABA» YA NO BLOQUEA + EL PLAZO PARA REPORTAR, 1 HORA (2026-10-12)
--
-- Dos decisiones del dueño (2026-10-12), «como las grandes» y ahora que
-- Umbani es solo app:
--
--   · EL CLIENTE QUE NO ESTABA ya no queda bloqueado en toda la plataforma:
--     durante 90 días solo paga POR ADELANTADO (tarjeta o transferencia). Es el
--     escalón 3 de la escalera, el mismo de quien reclama de más, y la app solo
--     le ofrece esos métodos, sin explicarle la regla. Las apps de reparto con
--     efectivo hacen eso: al que falló le desaparece el efectivo. Un bloqueo
--     sin explicación, en una app sin chat, dejaba fuera para siempre a quien
--     solo tuvo un imprevisto. El superadmin lo puede levantar antes.
--   · EL PLAZO PARA REPORTAR un problema baja de 48 horas a 1 HORA desde la
--     entrega, y deja de estar escrito a mano: vive en `server_settings`
--     (`reclamo_plazo_minutos`, de 5 minutos a 48 horas) y se cambia sin
--     publicar app. Uber Eats da 48 horas y DoorDash unas 24, pero venden de
--     todo; en comida, un reclamo de dos días después ya no se puede comprobar.
-- ============================================================================


-- ── 1. Hasta cuándo paga solo por adelantado, y quién lo levantó ────────────
-- La fecha la pone `aplicar_ajustes_de_la_incidencia` al resolver; la
-- escalera la lee; levantarlo la adelanta a «ahora». Una fecha, no una
-- cuenta: la pantalla, la escalera y el botón leen el mismo dato.
alter table public.order_incidents
  add column if not exists prepaid_only_until timestamptz,
  add column if not exists restriction_lifted_at timestamptz,
  add column if not exists restriction_lifted_by text;

alter table public.order_incidents drop constraint if exists order_incidents_levantada_check;
alter table public.order_incidents add constraint order_incidents_levantada_check check (
  restriction_lifted_by is null or char_length(restriction_lifted_by) between 1 and 120
);

-- La escalera lo pregunta en cada pedido en efectivo: son poquísimas filas.
create index if not exists idx_order_incidents_solo_adelantado
  on public.order_incidents (order_id, prepaid_only_until)
  where kind = 'cliente_ausente' and prepaid_only_until is not null;


-- ── 2. El plazo para reportar, en un solo sitio ─────────────────────────────
-- Lo usan la base (al reportar) y el servidor (para enseñar hasta cuándo).
create or replace function public.plazo_de_reclamo_minutos()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.parametro_entero('reclamo_plazo_minutos', 60, 5, 2880)
$$;

revoke all on function public.plazo_de_reclamo_minutos() from public, anon, authenticated;
grant execute on function public.plazo_de_reclamo_minutos() to service_role;


-- ── 3. Reportar: el plazo sale del ajuste ───────────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-10-usar-el-saldo.sql);
-- cambia solo lo marcado (2026-10-12).

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
  -- El plazo (2026-10-12): 1 hora por defecto, en `server_settings`.
  if v.entregado_en < now() - make_interval(mins => public.plazo_de_reclamo_minutos()) then
    return jsonb_build_object('result', 'fuera_de_plazo', 'plazoMinutos', public.plazo_de_reclamo_minutos());
  end if;

  select * into v_o from public.orders where id = v.order_id;
  v_total := round(coalesce(v_o.total, 0) * 100)::integer;

  if p_kind = 'no_llego' then
    -- No llegó nada: el pedido entero, repartido como lo reparte el libro.
    v_umbani := least(round(coalesce(v_o.platform_markup, 0) * 100)::integer, v_total);
    v_reparto := least(round(coalesce(v_o.shipping, 0) * 100)::integer, v_total - v_umbani);
    v_local := v_total - v_umbani - v_reparto;
    -- ⚠️ Iba a pagar al recibir y no recibió nada: NO pagó. No hay nada que
    -- devolverle en saldo (el reparto de arriba queda para cobrar la comida)…
    -- salvo lo que SÍ pagó con su saldo Umbani al pedir (2026-10-10).
    v_sugerido := case when coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
                       then least(coalesce(v_o.credit_cents, 0), v_total) else v_total end;
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


-- ── 4. La escalera: «no estaba» es escalón 3 mientras dure ──────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-10-saldo-umbani.sql);
-- cambia solo lo marcado (2026-10-12).

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
  -- No estaba para recibir un pedido y aún dura su «solo por adelantado» (2026-10-12).
  v_no_estuvo boolean := false;
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

    -- «No estaba» (2026-10-12): mientras dure, solo paga por adelantado. No es
    -- un reclamo suyo, así que va aparte de las cuentas de arriba.
    select exists (
      select 1 from public.order_incidents i
        join public.orders o on o.id = i.order_id
       where i.kind = 'cliente_ausente' and i.prepaid_only_until > now()
         and o.contact_phone = any (v_telefonos)
    ) into v_no_estuvo;
  end if;

  if v_rechazos >= v_sin_instante or v_no_estuvo then
    v_escalon := 3;
    v_motivos := case when v_rechazos >= v_sin_instante then array['rechazos'] else '{}'::text[] end
              || case when v_no_estuvo then array['no_estaba'] else '{}'::text[] end;
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
    'rechazos', v_rechazos, 'rechazosRecientes', v_rechazos_recientes, 'alInstante', v_al_instante,
    'noEstuvo', v_no_estuvo);
end;
$$;


-- ── 5. El efecto de resolver ya no bloquea ──────────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-12-ajustes-por-incidencia.sql);
-- cambia solo lo marcado (2026-10-12).

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
  v_solo_adelantado boolean := false;
begin
  select * into v_i from public.order_incidents where id = p_incident_id;
  if v_i.id is null then
    return jsonb_build_object('ajustes', '[]'::jsonb, 'soloPorAdelantado', false);
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
    -- El cliente que no estaba ya no se bloquea (2026-10-12): durante unos
    -- días solo paga por adelantado.
    v_solo_adelantado := v_i.kind = 'cliente_ausente' and p_responsible = 'cliente';
  end if;

  return jsonb_build_object(
    'ajustes', v_ajustes, 'soloPorAdelantado', v_solo_adelantado,
    'diasSoloPorAdelantado', case when v_solo_adelantado
      then public.parametro_entero('no_estaba_solo_adelantado_dias', 90, 1, 3650) end);
end;
$$;


-- ── 6. Aplicarlo: en vez del bloqueo, la fecha ──────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-12-ajustes-por-incidencia.sql);
-- cambia solo lo marcado (2026-10-12).

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

  -- El cliente que no estaba (2026-10-12): ya no se bloquea. Hasta esta
  -- fecha solo paga por adelantado (la escalera lo lee de aquí).
  if coalesce((v_efecto ->> 'soloPorAdelantado')::boolean, false) then
    update public.order_incidents
       set prepaid_only_until = now() + make_interval(days => (v_efecto ->> 'diasSoloPorAdelantado')::integer)
     where id = v_i.id and prepaid_only_until is null;
  end if;

  return v_efecto -> 'ajustes';
end;
$$;


-- ── 7. Umbani lo levanta antes ──────────────────────────────────────────────
-- Adelanta la fecha a «ahora» y deja quién y cuándo. Solo un «no estaba»
-- que aún dura: lo vencido o ya levantado no se toca.
create or replace function public.levantar_solo_adelantado(p_incident_id uuid, p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.order_incidents%rowtype;
begin
  select * into v_i from public.order_incidents where id = p_incident_id for update;
  if v_i.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_i.kind <> 'cliente_ausente' or v_i.prepaid_only_until is null or v_i.prepaid_only_until <= now() then
    return jsonb_build_object('result', 'no_activa');
  end if;
  update public.order_incidents
     set prepaid_only_until = now(),
         restriction_lifted_at = now(),
         restriction_lifted_by = left(coalesce(nullif(btrim(p_actor), ''), 'superadmin'), 120)
   where id = p_incident_id;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.levantar_solo_adelantado(uuid, text) from public, anon, authenticated;
grant execute on function public.levantar_solo_adelantado(uuid, text) to service_role;


-- ── 8. Lo que ya estaba: del bloqueo a la fecha ─────────────────────────────
-- Los «no estaba» resueltos antes de hoy pasan a la regla nueva (90 días
-- desde que se resolvieron), y quien quedó bloqueado por uno se desbloquea.
-- En producción no hay ninguno; en el staging, los de los ejemplos.
update public.order_incidents
   set prepaid_only_until = coalesce(resolved_at, created_at)
                          + make_interval(days => public.parametro_entero('no_estaba_solo_adelantado_dias', 90, 1, 3650))
 where kind = 'cliente_ausente' and status = 'resuelta' and responsible = 'cliente'
   and prepaid_only_until is null and restriction_lifted_at is null;

update public.customers
   set blocked_at = null, blocked_until = null, blocked_kind = null, blocked_reason = null
 where blocked_kind = 'manual' and blocked_reason like 'No estaba para recibir su pedido #%';
