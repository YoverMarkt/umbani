-- ============================================================================
-- EL REGISTRO DE QUIÉN MUEVE DINERO
--
-- Lo pidió el dueño el 2026-09-29, como segundo PR del bloque de seguridad del
-- cobro con tarjeta: hasta hoy, marcar una liquidación como pagada, retener la
-- carrera de un motorizado, confirmar un pago, cancelar un pedido YA pagado
-- (que dispara la devolución) o encender la tarjeta de un local no dejaba
-- rastro de QUIÉN lo hizo. Solo el resultado.
--
-- ⚠️ LO ANOTA LA BASE, no cada ruta. Un disparador en cada tabla de dinero
-- escribe el movimiento EN LA MISMA TRANSACCIÓN que el cambio: si el cambio se
-- guarda, su rastro también, y no hay forma de hacer lo uno sin lo otro.
-- Anotarlo desde las rutas dependía de que cada ruta —también las que se
-- escriban mañana— se acordara, que es el fallo de siempre en este proyecto:
-- construido y desconectado.
--
-- ⚠️ QUIÉN, desde la cabecera `x-umbani-actor`. El servidor la pone en CADA
-- consulta hecha dentro de una petición autenticada (`lib/actor-de-la-peticion`
-- + el `fetch` del cliente de la base), y PostgREST la deja en
-- `request.headers`. Solo el servidor habla con PostgREST —con la llave de
-- servicio—, así que ningún cliente puede inventársela.
--
--   · `superadmin:<correo>` / `local:<correo>` — una persona, desde un panel.
--   · `sistema` — el servidor sin persona detrás: la tarea de los lunes, la de
--     los cobros con tarjeta, la caducidad de pedidos.
--   · `base` — un cambio que NO pasó por el servidor: el editor SQL de
--     Supabase, una migración. Justo el que más conviene ver.
--
-- ⚠️ No se edita ni se borra: sin permiso de UPDATE/DELETE para nadie, y un
-- disparador que lo impide incluso a quien tuviera el permiso.
--
-- ⚠️ `business_id` SIN foránea a businesses, y es a propósito: borrar un local
-- no puede borrar su rastro de dinero. Por eso se guarda también su NOMBRE.
-- ============================================================================

create table if not exists public.money_audit_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor         text not null,
  -- ⚠️ Sin foránea: el rastro sobrevive al local. Ver la cabecera.
  business_id   uuid,
  business_name text,
  action        text not null,
  target_table  text not null,
  target_id     text,
  detail        jsonb not null default '{}'::jsonb,
  constraint money_audit_log_actor_check check (length(actor) between 1 and 200),
  constraint money_audit_log_action_check check (action ~ '^[a-z_]{3,60}$')
);

create index if not exists idx_money_audit_log_fecha
  on public.money_audit_log (created_at desc);
create index if not exists idx_money_audit_log_negocio
  on public.money_audit_log (business_id, created_at desc);

alter table public.money_audit_log enable row level security;

-- El patrón más estricto del proyecto: se retira el acceso a TODOS —incluido
-- `service_role`, que salta la RLS— y se devuelve solo leer y añadir.
revoke all on table public.money_audit_log
  from public, anon, authenticated, service_role;
grant select, insert on table public.money_audit_log to service_role;

comment on table public.money_audit_log is
  'Quién movió dinero, cuándo y qué cambió. Lo escribe la base con disparadores; no se edita ni se borra.';

-- ── No se edita ni se borra, ni con permiso ────────────────────────────────

create or replace function public.money_audit_log_inmutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'El registro de dinero no se edita ni se borra';
end;
$$;

revoke all on function public.money_audit_log_inmutable() from public, anon, authenticated;

drop trigger if exists money_audit_log_inmutable on public.money_audit_log;
create trigger money_audit_log_inmutable
  before update or delete on public.money_audit_log
  for each row execute function public.money_audit_log_inmutable();

drop trigger if exists money_audit_log_sin_vaciar on public.money_audit_log;
create trigger money_audit_log_sin_vaciar
  before truncate on public.money_audit_log
  for each statement execute function public.money_audit_log_inmutable();

-- ── Quién pidió el cambio ──────────────────────────────────────────────────

create or replace function public.actor_de_la_peticion()
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_cabeceras text := nullif(current_setting('request.headers', true), '');
  v_actor text;
begin
  -- Sin cabeceras de PostgREST, el cambio no pasó por el servidor.
  if v_cabeceras is null then
    return 'base';
  end if;
  begin
    v_actor := left(btrim(v_cabeceras::json ->> 'x-umbani-actor'), 200);
  exception when others then
    v_actor := null;
  end;
  return coalesce(nullif(v_actor, ''), 'sistema');
end;
$$;

revoke all on function public.actor_de_la_peticion() from public, anon, authenticated;
grant execute on function public.actor_de_la_peticion() to service_role;

-- ── La única puerta de escritura ───────────────────────────────────────────
--
-- `security definer`: escribe aunque el cambio lo haga un rol sin permiso de
-- INSERT sobre el registro. Lo llaman los disparadores de abajo, y nadie más.

create or replace function public.anotar_movimiento_de_dinero(
  p_business_id uuid,
  p_action text,
  p_target_table text,
  p_target_id text,
  p_detail jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.money_audit_log
    (actor, business_id, business_name, action, target_table, target_id, detail)
  values (
    public.actor_de_la_peticion(),
    p_business_id,
    (select b.name from public.businesses b where b.id = p_business_id),
    p_action,
    p_target_table,
    p_target_id,
    coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

-- ⚠️ `service_role` SÍ la ejecuta: los disparadores corren con el rol de quien
-- hace el cambio, y el servidor entra como `service_role`. Sin este permiso,
-- encender la tarjeta de un local desde el panel fallaría ENTERO por no poder
-- dejar su rastro.
revoke all on function public.anotar_movimiento_de_dinero(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.anotar_movimiento_de_dinero(uuid, text, text, text, jsonb)
  to service_role;

-- ── Los disparadores, tabla por tabla ──────────────────────────────────────

-- Las liquidaciones del local: la de los lunes las CREA; el superadmin las
-- marca PAGADAS con su referencia.
create or replace function public.settlements_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'liquidacion_cerrada', 'settlements',
      new.id::text, jsonb_build_object('party', new.party, 'desde', new.period_start,
        'hasta', new.period_end, 'neto_cents', new.neto_cents, 'estado', new.status));
  elsif old.status is distinct from new.status
     or old.reference is distinct from new.reference
     or old.neto_cents is distinct from new.neto_cents then
    perform public.anotar_movimiento_de_dinero(new.business_id,
      'liquidacion_' || coalesce(new.status, 'cambiada'), 'settlements', new.id::text,
      jsonb_build_object('desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'referencia', old.reference, 'neto_cents', old.neto_cents),
        'despues', jsonb_build_object('estado', new.status, 'referencia', new.reference, 'neto_cents', new.neto_cents)));
  end if;
  return null;
end;
$$;

revoke all on function public.settlements_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists settlements_registro_de_dinero on public.settlements;
create trigger settlements_registro_de_dinero
  after insert or update on public.settlements
  for each row execute function public.settlements_registro_de_dinero();

-- Las liquidaciones de los motorizados: igual, sin local.
create or replace function public.courier_settlements_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(null, 'liquidacion_motorizado_cerrada', 'courier_settlements',
      new.id::text, jsonb_build_object('motorizado', new.courier_id, 'desde', new.period_start,
        'hasta', new.period_end, 'neto_cents', new.neto_cents, 'estado', new.status));
  elsif old.status is distinct from new.status
     or old.reference is distinct from new.reference
     or old.neto_cents is distinct from new.neto_cents then
    perform public.anotar_movimiento_de_dinero(null,
      'liquidacion_motorizado_' || coalesce(new.status, 'cambiada'), 'courier_settlements', new.id::text,
      jsonb_build_object('motorizado', new.courier_id, 'desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'referencia', old.reference, 'neto_cents', old.neto_cents),
        'despues', jsonb_build_object('estado', new.status, 'referencia', new.reference, 'neto_cents', new.neto_cents)));
  end if;
  return null;
end;
$$;

revoke all on function public.courier_settlements_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists courier_settlements_registro_de_dinero on public.courier_settlements;
create trigger courier_settlements_registro_de_dinero
  after insert or update on public.courier_settlements
  for each row execute function public.courier_settlements_registro_de_dinero();

-- La carrera RETENIDA a un motorizado (se le cayó la comida).
create or replace function public.order_ledger_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.business_id,
    case when new.retenido then 'carrera_retenida' else 'carrera_liberada' end,
    'order_ledger', new.id::text,
    jsonb_build_object('pedido', new.order_id, 'motorizado', new.courier_id,
      'reparto_cents', new.reparto_cents, 'motivo', new.retenido_motivo));
  return null;
end;
$$;

revoke all on function public.order_ledger_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists order_ledger_registro_de_dinero on public.order_ledger;
create trigger order_ledger_registro_de_dinero
  after update of retenido on public.order_ledger
  for each row when (old.retenido is distinct from new.retenido)
  execute function public.order_ledger_registro_de_dinero();

-- Los cobros con tarjeta: solo los estados en que el dinero SE MUEVE. Los
-- intentos que nadie pagó (`caducado`) no son dinero, y serían ruido.
create or replace function public.payments_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.business_id, 'tarjeta_' || new.status,
    'payments', new.id::text,
    jsonb_build_object('pedido', new.order_id, 'modo', new.environment,
      'monto_cents', new.amount_cents, 'cobrado_cents', new.captured_cents,
      'antes', old.status, 'payphone', new.provider_transaction_id,
      'detalle', left(coalesce(new.status_detail, ''), 200)));
  return null;
end;
$$;

revoke all on function public.payments_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists payments_registro_de_dinero on public.payments;
create trigger payments_registro_de_dinero
  after update of status on public.payments
  for each row when (
    old.status is distinct from new.status
    and new.status in ('aprobado', 'no_confirmado', 'por_devolver', 'devuelto', 'devolucion_manual')
  )
  execute function public.payments_registro_de_dinero();

-- El pedido: un PAGO CONFIRMADO (la transferencia que aprueba el local, o la
-- tarjeta), y un pedido YA PAGADO que se cancela —que es lo que dispara la
-- devolución—.
create or replace function public.orders_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base jsonb := jsonb_build_object('numero', new.order_number,
    'metodo', new.payment_method, 'total', new.total);
begin
  if old.payment_confirmed_at is null and new.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pago_confirmado', 'orders',
      new.id::text, v_base);
  end if;
  if new.status = 'cancelado' and old.status is distinct from 'cancelado'
     and old.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pedido_pagado_cancelado', 'orders',
      new.id::text, v_base || jsonb_build_object('estaba', old.status));
  end if;
  return null;
end;
$$;

revoke all on function public.orders_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists orders_registro_de_dinero on public.orders;
create trigger orders_registro_de_dinero
  after update of payment_confirmed_at, status on public.orders
  for each row when (
    (old.payment_confirmed_at is null and new.payment_confirmed_at is not null)
    or (new.status = 'cancelado' and old.status is distinct from 'cancelado'
        and old.payment_confirmed_at is not null)
  )
  execute function public.orders_registro_de_dinero();

-- La facturación mensual del local (la cuota): se crea, se cobra, se ajusta.
create or replace function public.billing_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'factura_creada', 'billing',
      new.id::text, jsonb_build_object('monto', new.amount, 'desde', new.period_start,
        'hasta', new.period_end, 'estado', new.status));
  elsif old.status is distinct from new.status or old.amount is distinct from new.amount then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'factura_' || coalesce(new.status, 'cambiada'),
      'billing', new.id::text, jsonb_build_object('desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'monto', old.amount),
        'despues', jsonb_build_object('estado', new.status, 'monto', new.amount)));
  end if;
  return null;
end;
$$;

revoke all on function public.billing_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists billing_registro_de_dinero on public.billing;
create trigger billing_registro_de_dinero
  after insert or update on public.billing
  for each row execute function public.billing_registro_de_dinero();

-- La tarjeta de un local, encendida (en pruebas o de verdad) o apagada.
create or replace function public.businesses_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.id, 'tarjeta_del_local', 'businesses',
    new.id::text, jsonb_build_object('antes', old.card_mode, 'despues', new.card_mode));
  return null;
end;
$$;

revoke all on function public.businesses_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists businesses_registro_de_dinero on public.businesses;
create trigger businesses_registro_de_dinero
  after update of card_mode on public.businesses
  for each row when (old.card_mode is distinct from new.card_mode)
  execute function public.businesses_registro_de_dinero();

-- Las reglas del margen: lo que gana Umbani por pedido.
create or replace function public.pricing_rules_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fila public.pricing_rules := coalesce(new, old);
  v_regla jsonb := jsonb_build_object('alcance', v_fila.scope, 'destino', v_fila.target_name,
    'estrategia', v_fila.strategy, 'porcentaje', v_fila.percentage, 'fijo', v_fila.fixed_amount,
    'minimo', v_fila.min_amount, 'maximo', v_fila.max_amount, 'estado', v_fila.status,
    'version', v_fila.version);
begin
  perform public.anotar_movimiento_de_dinero(v_fila.business_id,
    case tg_op when 'INSERT' then 'margen_creado' when 'DELETE' then 'margen_borrado' else 'margen_cambiado' end,
    'pricing_rules', v_fila.id::text,
    case when tg_op = 'UPDATE'
      then jsonb_build_object('antes', jsonb_build_object('porcentaje', old.percentage, 'fijo', old.fixed_amount,
             'minimo', old.min_amount, 'maximo', old.max_amount, 'estado', old.status), 'despues', v_regla)
      else v_regla end);
  return null;
end;
$$;

revoke all on function public.pricing_rules_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists pricing_rules_registro_de_dinero on public.pricing_rules;
create trigger pricing_rules_registro_de_dinero
  after insert or update or delete on public.pricing_rules
  for each row execute function public.pricing_rules_registro_de_dinero();

-- Los ajustes que deciden dinero —la tarifa de servicio y lo que cobra
-- PayPhone—, y el SEGUNDO PASO del superadmin: configurarlo o reiniciarlo es
-- justo lo que alguien que quisiera entrar sin permiso haría primero. De la
-- clave no se guarda nada, solo que cambió.
create or replace function public.server_settings_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_clave text := coalesce(new.key, old.key);
begin
  if v_clave in ('service_fee', 'payphone_fee_bps') then
    if tg_op = 'UPDATE' and old.value is not distinct from new.value then
      return null;
    end if;
    perform public.anotar_movimiento_de_dinero(null, 'ajuste_' || v_clave, 'server_settings', v_clave,
      jsonb_build_object('antes', case when tg_op = 'INSERT' then null else old.value end,
        'despues', case when tg_op = 'DELETE' then null else new.value end));
  elsif v_clave = 'admin_totp_secret' then
    if tg_op = 'UPDATE' and old.value is not distinct from new.value then
      return null;
    end if;
    perform public.anotar_movimiento_de_dinero(null,
      case when tg_op = 'DELETE' then 'segundo_paso_reiniciado' else 'segundo_paso_configurado' end,
      'server_settings', v_clave, '{}'::jsonb);
  end if;
  return null;
end;
$$;

revoke all on function public.server_settings_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists server_settings_registro_de_dinero on public.server_settings;
create trigger server_settings_registro_de_dinero
  after insert or update or delete on public.server_settings
  for each row execute function public.server_settings_registro_de_dinero();

-- ── La lectura del superadmin ──────────────────────────────────────────────

create or replace function public.money_audit_log_recent(
  p_limite integer default 200,
  p_business_id uuid default null,
  p_antes_de bigint default null
)
returns setof public.money_audit_log
language sql
stable
set search_path = public, pg_temp
as $$
  select *
    from public.money_audit_log
   where (p_business_id is null or business_id = p_business_id)
     and (p_antes_de is null or id < p_antes_de)
   order by id desc
   limit least(greatest(coalesce(p_limite, 200), 1), 500);
$$;

revoke all on function public.money_audit_log_recent(integer, uuid, bigint) from public, anon, authenticated;
grant execute on function public.money_audit_log_recent(integer, uuid, bigint) to service_role;
