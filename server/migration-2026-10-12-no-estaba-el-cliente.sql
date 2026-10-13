-- ============================================================================
-- «NO ESTABA EL CLIENTE»: QUIEN REPARTE CIERRA EL PEDIDO (2026-10-12)
--
-- Decisión del dueño (2026-10-12, pieza 4 de las incidencias), «como las
-- grandes»: Uber Eats y DoorDash dejan al repartidor marcar que el cliente no
-- estaba tras esperarlo en la puerta, y el pedido se cobra SIN reembolso
-- (ayuda oficial de Uber). Hasta hoy eso no existía: el repartidor solo podía
-- marcar «entregado» —mintiendo, y en efectivo quedaba debiendo lo que nunca
-- cobró— o pedirle al local que lo cancelara, y cancelar un pedido pagado con
-- tarjeta DEVUELVE el dinero solo (`orders_card_refund_on_cancel`).
--
--   · «LLEGUÉ»: el repartidor (o el local que reparte él mismo) lo toca en la
--     puerta. Se guarda cuándo y, si el teléfono da la ubicación, a cuántos
--     metros de la dirección estaba. NO bloquea —el GPS falla en interiores—:
--     es la prueba que mira Umbani si el cliente dice «sí estaba». Desde ese
--     momento el repartidor ve el teléfono del cliente para llamarlo.
--   · «NO ESTABA EL CLIENTE», a los 10 minutos de «Llegué»
--     (`no_estaba_espera_minutos` en `server_settings`, se cambia sin publicar
--     app). La base lo rechaza antes, aunque alguien llame a la API directo.
--   · EL PEDIDO SE CIERRA COMO ENTREGADO, CON UNA MARCA (`customer_absent_at`),
--     y no con un estado nuevo: «entregado» ya hace bien todo el dinero —la
--     venta, el libro, la liquidación del lunes— y la tarjeta no se devuelve
--     porque solo se devuelve al cancelar. Un estado nuevo habría que
--     enseñárselo a cada función que pregunta «¿sigue activo?» (el efectivo
--     encima del repartidor, su lista, la alarma…), y uno olvidado deja el
--     pedido vivo para siempre. Donde «entregado» significa «lo recibió» se
--     mira la marca: el reclamo, «todo bien» y la escalera.
--   · EL DINERO: con tarjeta o transferencia, como un pedido entregado (el
--     local cobra su comida, quien repartió su carrera, Umbani su comisión).
--     En EFECTIVO nadie cobró: se deshace el cobro que el libro le anotó a
--     quien lo tenía en la mano (`no_cobro`, el mismo de «no llegó»), así que
--     la comida del local y la carrera las pone Umbani. El saldo Umbani que
--     usó el cliente no vuelve, igual que la tarjeta.
--   · LA INCIDENCIA NACE SOLA (`origin = 'reparto'`), ya resuelta con
--     «responde el cliente»: 90 días solo paga por adelantado (la regla que ya
--     estaba, `no_estaba_solo_adelantado_dias`). Umbani la levanta antes con
--     el botón de siempre.
--   · SI EL CLIENTE DICE «SÍ ESTABA»: en el plazo de siempre (1 hora) puede
--     reportar SOLO «No me llegó», que va siempre a revisión. Si el repartidor
--     mintió, se resuelve con la regla de «no llegó» y paga él la comida; el
--     cobro deshecho no se deshace dos veces.
--   · La comida se la queda el repartidor (decisión del dueño): ya está
--     pagada y no se puede revender. No hay nada que guardar para eso.
-- ============================================================================


-- ── 1. Las marcas en el pedido ──────────────────────────────────────────────
-- Tres datos, no un estado: cuándo llegó quien repartía, a cuántos metros de
-- la dirección (si se supo) y cuándo marcó que el cliente no estaba.
alter table public.orders
  add column if not exists arrived_at timestamptz,
  add column if not exists arrived_distance_m integer,
  add column if not exists customer_absent_at timestamptz;

comment on column public.orders.arrived_at is
  'Cuándo tocó «Llegué» quien repartía. Desde aquí cuentan los minutos antes de poder marcar «No estaba el cliente».';
comment on column public.orders.arrived_distance_m is
  'A cuántos metros de la dirección de entrega estaba al tocar «Llegué», si el teléfono dio la ubicación. Prueba para revisar un «sí estaba»; no bloquea.';
comment on column public.orders.customer_absent_at is
  'El cliente no estaba: quien repartía cerró el pedido como entregado sin entregarlo. Se cobra sin devolución.';

-- ⚠️ La marca solo vive en un pedido CERRADO por quien llegó: un pedido sin
-- «Llegué», o que no esté entregado, no puede llevarla.
alter table public.orders drop constraint if exists orders_no_estaba_check;
alter table public.orders add constraint orders_no_estaba_check check (
  (arrived_distance_m is null or arrived_distance_m between 0 and 20000000)
  and (customer_absent_at is null or (arrived_at is not null and status = 'completado'))
);


-- ── 2. Cuánto se espera en la puerta, en un solo sitio ──────────────────────
-- Lo usan la base (al cerrar) y la lista del repartidor (desde cuándo).
create or replace function public.espera_no_estaba_minutos()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.parametro_entero('no_estaba_espera_minutos', 10, 1, 60)
$$;

revoke all on function public.espera_no_estaba_minutos() from public, anon, authenticated;
grant execute on function public.espera_no_estaba_minutos() to service_role;


-- ── 3. La incidencia que abre quien reparte ─────────────────────────────────
-- `reparto` = la abrió quien llevaba el pedido (el repartidor o el local que
-- reparte él mismo). Una por pedido: el pedido se cierra una sola vez.
alter table public.order_incidents drop constraint if exists order_incidents_origin_check;
alter table public.order_incidents add constraint order_incidents_origin_check
  check (origin in ('cliente', 'superadmin', 'reparto'));

create unique index if not exists order_incidents_un_no_estaba_por_pedido
  on public.order_incidents (order_id) where origin = 'reparto';


-- ── 4. ¿Lo lleva quien lo pide? ─────────────────────────────────────────────
-- El repartidor: solo SU pedido. El local: lo que reparte él mismo —sin
-- repartidor, o con uno de SU flota—; lo que lleva un repartidor de Umbani o
-- de una cooperativa lo cierra ese repartidor, no el local.
-- ⚠️ Exactamente uno de los dos: con los dos o ninguno, nadie.
create or replace function public.lleva_el_pedido(p_order_id uuid, p_courier_id uuid, p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.orders o
      left join public.couriers c on c.id = o.courier_id
     where o.id = p_order_id
       and (
         (p_courier_id is not null and p_business_id is null and o.courier_id = p_courier_id)
         or (p_business_id is not null and p_courier_id is null and o.business_id = p_business_id
             and (o.courier_id is null or coalesce(c.fleet_business_id = p_business_id, false)))
       )
  )
$$;

revoke all on function public.lleva_el_pedido(uuid, uuid, uuid) from public, anon, authenticated;


-- ── 5. «Llegué» ─────────────────────────────────────────────────────────────
-- ⚠️ El PRIMER toque cuenta: tocarlo otra vez no reinicia la espera ni borra
-- dónde estaba. La ubicación es opcional y no bloquea nada.
create or replace function public.pedido_llegue(
  p_order_id uuid, p_courier_id uuid default null, p_business_id uuid default null,
  p_lat numeric default null, p_lng numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
  v_metros integer;
begin
  select * into v_o from public.orders where id = p_order_id for update;
  -- El mismo «no existe» para lo ajeno: no se confirma qué pedidos hay.
  if v_o.id is null or not public.lleva_el_pedido(p_order_id, p_courier_id, p_business_id) then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_o.status <> 'en_camino' then
    return jsonb_build_object('result', 'no_en_camino');
  end if;

  if v_o.arrived_at is null then
    if p_lat between -90 and 90 and p_lng between -180 and 180
       and v_o.delivery_latitude is not null and v_o.delivery_longitude is not null then
      v_metros := round(public.distancia_km(p_lat, p_lng, v_o.delivery_latitude, v_o.delivery_longitude) * 1000)::integer;
    end if;
    update public.orders
       set arrived_at = now(), arrived_distance_m = v_metros, updated_at = now()
     where id = v_o.id
    returning * into v_o;
  end if;

  return jsonb_build_object('result', 'ok', 'llegoEn', v_o.arrived_at,
    'noEstabaDesde', v_o.arrived_at + make_interval(mins => public.espera_no_estaba_minutos()),
    'metros', v_o.arrived_distance_m);
end;
$$;

revoke all on function public.pedido_llegue(uuid, uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.pedido_llegue(uuid, uuid, uuid, numeric, numeric) to service_role;


-- ── 6. «No estaba el cliente» ───────────────────────────────────────────────
-- TODO en una transacción: el pedido pasa a entregado por la única puerta que
-- mueve estados (`set_order_status`: venta y libro), lleva su marca, nace la
-- incidencia ya resuelta y se aplican sus ajustes (el cobro deshecho en
-- efectivo y los 90 días por adelantado). Si algo falla, no pasa nada de eso.
-- ⚠️ Idempotente: el segundo toque responde lo mismo sin repetir nada.
create or replace function public.pedido_cliente_ausente(
  p_order_id uuid, p_courier_id uuid default null, p_business_id uuid default null, p_actor text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
  v_r jsonb;
  v_espera integer := public.espera_no_estaba_minutos();
  v_id uuid;
  v_ajustes jsonb;
  v_actor text := left(coalesce(nullif(btrim(p_actor), ''), 'reparto'), 120);
begin
  select * into v_o from public.orders where id = p_order_id for update;
  if v_o.id is null or not public.lleva_el_pedido(p_order_id, p_courier_id, p_business_id) then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_o.customer_absent_at is not null then
    return jsonb_build_object('result', 'ok', 'order', to_jsonb(v_o),
      'incidentId', (select i.id from public.order_incidents i where i.order_id = v_o.id and i.origin = 'reparto'));
  end if;
  if v_o.status <> 'en_camino' then
    return jsonb_build_object('result', 'no_en_camino');
  end if;
  if v_o.arrived_at is null then
    return jsonb_build_object('result', 'sin_llegada');
  end if;
  if now() < v_o.arrived_at + make_interval(mins => v_espera) then
    return jsonb_build_object('result', 'todavia_no',
      'noEstabaDesde', v_o.arrived_at + make_interval(mins => v_espera));
  end if;

  -- Entregado = vendido: la venta y el libro, como cualquier entrega.
  v_r := public.set_order_status(v_o.business_id, v_o.id, 'completado');
  if v_r ->> 'result' <> 'updated' then
    return v_r;
  end if;
  update public.orders set customer_absent_at = now()
   where id = v_o.id
  returning * into v_o;

  insert into public.order_incidents (
    business_id, order_id, courier_id, kind, origin, status, responsible,
    suggested_cents, compensation_cents, note, resolution_note, resolved_by, resolved_at, customer_id
  ) values (
    v_o.business_id, v_o.id, v_o.courier_id, 'cliente_ausente', 'reparto', 'resuelta', 'cliente',
    0, 0,
    format('Llegó a las %s%s y esperó %s minutos.',
      to_char(v_o.arrived_at at time zone 'America/Guayaquil', 'HH24:MI'),
      case when v_o.arrived_distance_m is null then ' (sin ubicación)'
           else ' a ' || v_o.arrived_distance_m || ' m de la dirección' end,
      floor(extract(epoch from (v_o.customer_absent_at - v_o.arrived_at)) / 60)::integer),
    'Lo marcó quien repartía: el cliente no estaba.',
    v_actor, now(),
    coalesce(v_o.customer_id, public.cliente_del_telefono(v_o.contact_phone))
  )
  returning id into v_id;

  -- El cobro deshecho (efectivo) y los 90 días por adelantado.
  v_ajustes := public.aplicar_ajustes_de_la_incidencia(v_id);

  -- Con tarjeta o transferencia el dinero ya estaba y se queda: que conste.
  perform public.anotar_movimiento_de_dinero(v_o.business_id, 'pedido_no_estaba', 'orders', v_o.id::text,
    jsonb_build_object('numero', v_o.order_number, 'metodo', v_o.payment_method, 'total', v_o.total,
                       'saldoCents', v_o.credit_cents, 'llegoEn', v_o.arrived_at,
                       'metros', v_o.arrived_distance_m, 'quien', v_actor));

  return jsonb_build_object('result', 'ok', 'order', to_jsonb(v_o), 'incidentId', v_id, 'ajustes', v_ajustes);
end;
$$;

revoke all on function public.pedido_cliente_ausente(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.pedido_cliente_ausente(uuid, uuid, uuid, text) to service_role;


-- ── 7. El efecto: el pedido que cerró quien reparte ─────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-12-no-estaba-y-plazo.sql);
-- cambia solo lo marcado (2026-10-12, «no estaba el cliente»).

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
           and not exists (select 1 from public.order_ledger r where r.order_id = v_o.id and r.kind = 'reverso')
           -- ⚠️ Una vez por PEDIDO (2026-10-12): si quien repartía ya lo cerró
           -- con «No estaba el cliente», ese cobro ya se deshizo; el «sí
           -- estaba» del cliente no puede deshacerlo otra vez.
           and not exists (select 1 from public.settlement_adjustments a
                            where a.order_id = v_o.id and a.concepto = 'no_cobro' and a.incident_id <> v_i.id) then
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
  elsif v_i.kind = 'cliente_ausente' and v_o.customer_absent_at is not null then
    -- ── «No estaba el cliente», cerrado por quien repartía (2026-10-12) ────
    -- El pedido quedó ENTREGADO, con su venta y su libro: el local ya cobra
    -- su comida y quien repartió su carrera, así que aquí no se le
    -- «reconoce» nada a nadie (sería pagarle dos veces). Solo en EFECTIVO:
    -- nadie cobró, y se deshace el cobro que el libro le anotó a quien lo
    -- tenía en la mano. Así la comida y la carrera las pone Umbani.
    if coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar') then
      select * into v_libro from public.order_ledger
       where order_id = v_o.id and kind = 'venta';
      if v_libro.id is not null and v_libro.en_mano in ('local', 'motorizado') and v_libro.en_mano_cents > 0
         and not exists (select 1 from public.order_ledger r where r.order_id = v_o.id and r.kind = 'reverso')
         and not exists (select 1 from public.settlement_adjustments a
                          where a.order_id = v_o.id and a.concepto = 'no_cobro' and a.incident_id <> v_i.id) then
        v_ajustes := v_ajustes || jsonb_build_object(
          'party', v_libro.en_mano,
          'courierId', case when v_libro.en_mano = 'motorizado' then v_libro.courier_id end,
          'cents', v_libro.en_mano_cents,
          'concepto', 'no_cobro');
      end if;
    end if;
    v_solo_adelantado := p_responsible = 'cliente';
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


-- ── 8. Reportar: de un «no estaba», solo «No me llegó» ──────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-12-no-estaba-y-plazo.sql);
-- cambia solo lo marcado (2026-10-12, «no estaba el cliente»).

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
  -- ⚠️ Lo cerró quien repartía porque no estaba (2026-10-12): no recibió
  -- nada, así que no le pudo faltar ni venir mal algo. Lo único que puede
  -- decir es que SÍ estaba —«No me llegó»—, y eso va siempre a revisión.
  if p_kind <> 'no_llego'
     and exists (select 1 from public.orders o where o.id = v.order_id and o.customer_absent_at is not null) then
    return jsonb_build_object('result', 'no_estabas');
  end if;
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
  -- Quien repartía dijo que no estaba (2026-10-12): la persona que lo revise
  -- lo ve, junto a la hora y la distancia del «Llegué».
  if v_o.customer_absent_at is not null then v_motivos := v_motivos || 'dice_que_si_estaba'::text; end if;
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


-- ── 9. «Todo bien» no vale para lo que no se entregó ────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-10-06-incidencias.sql);
-- cambia solo lo marcado (2026-10-12, «no estaba el cliente»).

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
  -- Lo que no se le entregó porque no estaba (2026-10-12) no «llegó bien».
  if exists (select 1 from public.orders o where o.id = v.order_id and o.customer_absent_at is not null) then
    return jsonb_build_object('result', 'no_entregado');
  end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  update public.orders set received_ok_at = coalesce(received_ok_at, now()) where id = v.order_id;
  return jsonb_build_object('result', 'ok');
end;
$$;


-- ── 10. La escalera no cuenta como recibido lo que no recibió ───────────────
-- Copiada ENTERA de la vigente (migration-2026-10-12-no-estaba-y-plazo.sql);
-- cambia solo lo marcado (2026-10-12, «no estaba el cliente»).

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
    -- Sin los que cerró quien repartía porque no estaba (2026-10-12): esos no
    -- los recibió, y contarlos le rebajaría la proporción de reportes.
    select count(*) into v_entregados
      from public.orders o
     where o.status = 'completado' and o.customer_absent_at is null
       and o.contact_phone = any (v_telefonos);

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


-- ── 11. La lista del repartidor: «Llegué» y el teléfono del cliente ─────────
-- Copiada ENTERA de la vigente (migration-2026-10-10-usar-el-saldo.sql);
-- cambia solo lo marcado (2026-10-12, «no estaba el cliente»).

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
          and public.repartidor_puede_llevar(yo.id, o.business_id)
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
    -- ⚠️ Lo que COBRA en la puerta (2026-10-10): el total menos lo que el
    -- cliente pagó con saldo Umbani. Cobrar `totalCents` sería cobrar de más.
    'cobrarCents', case when coalesce(p.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
                        then round(p.total * 100)::integer - coalesce(p.credit_cents, 0) else 0 end,
    'recoger', jsonb_build_object('local', p.local_nombre, 'direccion', p.local_direccion,
                                  'lat', p.local_lat, 'lng', p.local_lng),
    'entregar', jsonb_build_object('cliente', p.contact_name, 'direccion', p.delivery_address,
                                   'referencia', p.delivery_reference, 'notas', p.delivery_courier_notes,
                                   'lat', p.delivery_latitude, 'lng', p.delivery_longitude,
                                   -- ⚠️ El teléfono, SOLO desde «Llegué» y mientras lo lleva
                                   -- (decisión del dueño, 2026-10-12): para llamarlo en la
                                   -- puerta. Al cerrarlo, el pedido sale de esta lista.
                                   'telefono', case when p.courier_id is not null and p.status = 'en_camino'
                                                     and p.arrived_at is not null
                                                     and regexp_replace(coalesce(p.contact_phone, ''), '\D', '', 'g') <> ''
                                                    then '+' || regexp_replace(p.contact_phone, '\D', '', 'g') end),
    -- «Llegué» y desde cuándo puede marcar «No estaba el cliente» (2026-10-12).
    'llegoEn', p.arrived_at,
    'noEstabaDesde', p.arrived_at + make_interval(mins => public.espera_no_estaba_minutos())
  ) order by p.courier_id is null, p.created_at), '[]'::jsonb)
  from pedidos p
$$;
